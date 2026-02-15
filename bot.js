require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const { ethers } = require('ethers');

const execPromise = util.promisify(exec);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const templatesPath = path.join(__dirname, 'templates.json');
let templates = { metaplex: [], evm: [] };
try {
  templates = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
} catch (error) {
  console.error('Cannot read templates.json:', error.message);
  process.exit(1);
}

const userSessions = new Map();
const deployHistory = new Map();

const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS
      .split(',')
      .map(id => Number.parseInt(id.trim(), 10))
      .filter(Number.isInteger)
  : null;

function isUserAllowed(userId) {
  if (!ALLOWED_USERS) return true;
  return ALLOWED_USERS.includes(userId);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Не найден ${label}: ${filePath}`);
  }
}

function ensureDirExists(dirPath, label) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Не найдена папка ${label}: ${dirPath}`);
  }
}

function getMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎨 Solana (Metaplex)', callback_data: 'menu_metaplex' }],
        [{ text: '⚡ EVM Token Deploy', callback_data: 'menu_evm' }],
        [{ text: '💰 Проверить балансы', callback_data: 'check_balance' }],
        [{ text: '📋 Мои деплои', callback_data: 'my_deploys' }],
        [{ text: 'ℹ️ Помощь', callback_data: 'help' }]
      ]
    }
  };
}

function getSectionMenu(type) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Выбрать шаблон', callback_data: `${type}_template` }],
        [{ text: '✏️ Кастомный деплой', callback_data: `${type}_custom` }],
        [{ text: '◀️ Назад', callback_data: 'back_main' }]
      ]
    }
  };
}

function getTemplateList(type) {
  const list = Array.isArray(templates[type]) ? templates[type] : [];
  const keyboard = list.map(item => [{ text: item.name, callback_data: `template_${type}_${item.id}` }]);
  keyboard.push([{ text: '◀️ Назад', callback_data: `menu_${type}` }]);

  return {
    reply_markup: {
      inline_keyboard: keyboard
    }
  };
}

function addHistory(userId, entry) {
  const prev = deployHistory.get(userId) || [];
  const next = [entry, ...prev].slice(0, 12);
  deployHistory.set(userId, next);
}

function getProjectPaths() {
  const root = path.resolve(__dirname, '..');
  return {
    metaplexDir: path.join(root, 'metaplex-mint'),
    metaplexScript: path.join(root, 'metaplex-mint', 'mint_via_metaplex.js'),
    evmDir: path.join(root, 'evm-token-cli'),
    evmScript: path.join(root, 'evm-token-cli', 'script', 'DeployGenerated.s.sol'),
    evmBaseContract: path.join(root, 'evm-token-cli', 'src', 'CustomERC20.sol')
  };
}

function normalizeMetaplexParams(params) {
  return {
    name: String(params.name || '').trim(),
    symbol: String(params.symbol || '').trim(),
    tokens: Number(params.tokens),
    uri: String(params.uri || '').trim(),
    decimals: Number.isInteger(Number(params.decimals)) ? Number(params.decimals) : 6,
    network: ['mainnet', 'devnet'].includes(String(params.network || '').trim())
      ? String(params.network).trim()
      : 'mainnet',
    prefix: params.prefix ? String(params.prefix).trim() : '',
    suffix: params.suffix ? String(params.suffix).trim() : ''
  };
}

function normalizeEvmParams(params) {
  return {
    name: String(params.name || '').trim(),
    symbol: String(params.symbol || '').trim(),
    decimals: Number.isInteger(Number(params.decimals)) ? Number(params.decimals) : 18,
    network: ['ethereum', 'bsc', 'base'].includes(String(params.network || '').trim())
      ? String(params.network).trim()
      : 'ethereum'
  };
}

function getSolscanClusterSuffix(network) {
  return network === 'devnet' ? '?cluster=devnet' : '';
}

async function deployMetaplex(chatId, userId, rawParams) {
  const startedAt = new Date();
  const params = normalizeMetaplexParams(rawParams);

  if (!params.name || !params.symbol || !params.uri) {
    return bot.sendMessage(chatId, '❌ Для Metaplex нужны: name, symbol и uri.');
  }
  if (!Number.isFinite(params.tokens) || params.tokens <= 0) {
    return bot.sendMessage(chatId, '❌ Количество токенов должно быть положительным числом.');
  }

  try {
    const { metaplexDir, metaplexScript } = getProjectPaths();
    ensureDirExists(metaplexDir, 'metaplex-mint');
    ensureFileExists(metaplexScript, 'mint_via_metaplex.js');

    const solKeypair = process.env.SOL_KEYPAIR;
    if (!solKeypair) {
      throw new Error('В .env не задан SOL_KEYPAIR');
    }
    ensureFileExists(solKeypair, 'SOL_KEYPAIR');

    await bot.sendMessage(chatId, '⏳ Запускаю деплой Solana (Metaplex)...');

    let command = `cd ${shellEscape(metaplexDir)} && SOL_KEYPAIR=${shellEscape(solKeypair)} node mint_via_metaplex.js --name ${shellEscape(params.name)} --symbol ${shellEscape(params.symbol)} --tokens ${params.tokens} --uri ${shellEscape(params.uri)} --decimals ${params.decimals} --network ${shellEscape(params.network)}`;

    if (params.prefix) {
      command += ` --prefix ${shellEscape(params.prefix)}`;
    }
    if (params.suffix) {
      command += ` --suffix ${shellEscape(params.suffix)}`;
    }

    const { stdout } = await execPromise(command, { timeout: 8 * 60 * 1000 });
    const mintMatch = stdout.match(/Mint:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
    const mint = mintMatch ? mintMatch[1] : 'не найден в логе';
    const signatureMatch = stdout.match(/Signature:\s*([1-9A-HJ-NP-Za-km-z]{32,88})/);
    const signature = signatureMatch ? signatureMatch[1] : null;
    const clusterSuffix = getSolscanClusterSuffix(params.network);
    const mintUrl = mint !== 'не найден в логе' ? `https://solscan.io/token/${mint}${clusterSuffix}` : null;
    const txUrl = signature ? `https://solscan.io/tx/${signature}${clusterSuffix}` : null;

    addHistory(userId, {
      time: startedAt.toISOString(),
      type: 'metaplex',
      status: 'success',
      summary: `${params.name} (${params.symbol}), mint: ${mint}`
    });

    userSessions.delete(userId);
    const lines = [
      '✅ Solana токен задеплоен',
      '',
      `Сеть: ${params.network}`,
      `Mint: ${mint}`,
      `Название: ${params.name}`,
      `Символ: ${params.symbol}`
    ];
    if (mintUrl) lines.push(`Solscan token: ${mintUrl}`);
    if (txUrl) lines.push(`Solscan tx: ${txUrl}`);

    return bot.sendMessage(chatId, lines.join('\n'));
  } catch (error) {
    addHistory(userId, {
      time: startedAt.toISOString(),
      type: 'metaplex',
      status: 'error',
      summary: error.message
    });
    return bot.sendMessage(chatId, `❌ Ошибка Metaplex деплоя:\n${error.message}`);
  }
}

async function deployEvm(chatId, userId, rawParams) {
  const startedAt = new Date();
  const params = normalizeEvmParams(rawParams);

  if (!params.name || !params.symbol) {
    return bot.sendMessage(chatId, '❌ Для EVM нужны: name и symbol.');
  }

  const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
  if (!evmPrivateKey || evmPrivateKey === 'your_private_key_here') {
    return bot.sendMessage(chatId, '❌ EVM_PRIVATE_KEY не настроен в .env');
  }

  const networks = {
    ethereum: { name: 'Ethereum', rpc: 'https://eth.llamarpc.com', explorer: 'https://etherscan.io' },
    bsc: { name: 'BSC', rpc: 'https://bsc-dataseed.binance.org', explorer: 'https://bscscan.com' },
    base: { name: 'Base', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' }
  };

  const target = networks[params.network];
  if (!target) {
    return bot.sendMessage(chatId, '❌ Неизвестная EVM сеть.');
  }

  let tempEnvPath = null;

  try {
    const { evmDir, evmScript, evmBaseContract } = getProjectPaths();
    ensureDirExists(evmDir, 'evm-token-cli');
    ensureFileExists(evmScript, 'DeployGenerated.s.sol');
    ensureFileExists(evmBaseContract, 'CustomERC20.sol');

    await bot.sendMessage(chatId, `⏳ Запускаю деплой EVM токена в ${target.name}...`);

    const generatedContract = `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.26;\n\nimport {CustomERC20} from \"./CustomERC20.sol\";\n\ncontract GeneratedToken is CustomERC20 {\n    constructor(\n        string memory name_,\n        string memory symbol_,\n        uint8 decimals_,\n        bool enablePausable_,\n        bool enablePermit_,\n        address owner_\n    ) CustomERC20(name_, symbol_, decimals_, enablePausable_, enablePermit_, owner_) {}\n\n    fallback() external {}\n}\n`;
    fs.writeFileSync(path.join(evmDir, 'src', 'GeneratedToken.sol'), generatedContract);

    const envContent = [
      `TOKEN_NAME=${String(params.name).replace(/\r?\n/g, ' ').trim()}`,
      `TOKEN_SYMBOL=${String(params.symbol).replace(/\r?\n/g, ' ').trim()}`,
      `TOKEN_DECIMALS=${params.decimals}`,
      'ENABLE_PAUSABLE=false',
      'ENABLE_PERMIT=false',
      `PRIVATE_KEY=${String(evmPrivateKey).replace(/\r?\n/g, ' ').trim()}`,
      ''
    ].join('\n');

    tempEnvPath = path.join(evmDir, '.env');
    fs.writeFileSync(tempEnvPath, envContent);

    await execPromise(`cd ${shellEscape(evmDir)} && forge build`, { timeout: 2 * 60 * 1000 });

    const { stdout } = await execPromise(
      `cd ${shellEscape(evmDir)} && forge script script/DeployGenerated.s.sol:DeployGenerated --rpc-url ${shellEscape(target.rpc)} --broadcast`,
      { timeout: 6 * 60 * 1000 }
    );

    const tokenMatch = stdout.match(/Token deployed:\s*(0x[a-fA-F0-9]{40})/);
    const tokenAddress = tokenMatch ? tokenMatch[1] : 'не найден в логе';
    const txMatch = stdout.match(/transactionHash[\s:"]+(0x[a-fA-F0-9]{64})/i) || stdout.match(/\b(0x[a-fA-F0-9]{64})\b/);
    const txHash = txMatch ? txMatch[1] : null;
    const tokenUrl = tokenAddress !== 'не найден в логе' ? `${target.explorer}/address/${tokenAddress}` : null;
    const txUrl = txHash ? `${target.explorer}/tx/${txHash}` : null;

    addHistory(userId, {
      time: startedAt.toISOString(),
      type: 'evm',
      status: 'success',
      summary: `${params.name} (${params.symbol}), ${target.name}, address: ${tokenAddress}`
    });

    userSessions.delete(userId);
    const lines = [
      '✅ EVM токен задеплоен',
      '',
      `Сеть: ${target.name}`,
      `Адрес: ${tokenAddress}`,
      `Название: ${params.name}`,
      `Символ: ${params.symbol}`
    ];
    if (tokenUrl) lines.push(`Explorer token: ${tokenUrl}`);
    if (txUrl) lines.push(`Explorer tx: ${txUrl}`);

    return bot.sendMessage(chatId, lines.join('\n'));
  } catch (error) {
    addHistory(userId, {
      time: startedAt.toISOString(),
      type: 'evm',
      status: 'error',
      summary: error.message
    });
    return bot.sendMessage(chatId, `❌ Ошибка EVM деплоя:\n${error.message}`);
  } finally {
    if (tempEnvPath && fs.existsSync(tempEnvPath)) {
      fs.unlinkSync(tempEnvPath);
    }
  }
}

async function checkBalances(chatId) {
  const lines = ['💰 Балансы:'];

  try {
    const solKeypair = process.env.SOL_KEYPAIR;
    if (solKeypair && fs.existsSync(solKeypair)) {
      // solana-keygen может не обработать пути с пробелами/кириллицей; используем временный ASCII-путь.
      const tmpKeypairPath = path.join(os.tmpdir(), `solana-keypair-${Date.now()}.json`);
      fs.copyFileSync(solKeypair, tmpKeypairPath);
      let addrOut;
      try {
        ({ stdout: addrOut } = await execPromise(`solana-keygen pubkey ${shellEscape(tmpKeypairPath)}`, { timeout: 10000 }));
      } finally {
        if (fs.existsSync(tmpKeypairPath)) fs.unlinkSync(tmpKeypairPath);
      }
      const address = addrOut.trim();
      const { stdout: balOut } = await execPromise(`solana balance ${shellEscape(address)}`, { timeout: 10000 });
      lines.push('');
      lines.push(`Solana: ${address}`);
      lines.push(`Баланс: ${balOut.trim()}`);
    } else {
      lines.push('');
      lines.push('Solana: SOL_KEYPAIR не настроен или файл не найден.');
    }
  } catch (error) {
    lines.push('');
    lines.push(`Solana: ошибка проверки (${error.message})`);
  }

  try {
    const key = process.env.EVM_PRIVATE_KEY;
    if (key && key !== 'your_private_key_here') {
      const wallet = new ethers.Wallet(key);
      const networks = [
        { name: 'Ethereum', rpc: 'https://eth.llamarpc.com', symbol: 'ETH' },
        { name: 'BSC', rpc: 'https://bsc-dataseed.binance.org', symbol: 'BNB' },
        { name: 'Base', rpc: 'https://mainnet.base.org', symbol: 'ETH' }
      ];

      lines.push('');
      lines.push(`EVM address: ${wallet.address}`);

      for (const net of networks) {
        try {
          const provider = new ethers.JsonRpcProvider(net.rpc);
          const bal = await provider.getBalance(wallet.address);
          lines.push(`${net.name}: ${Number.parseFloat(ethers.formatEther(bal)).toFixed(6)} ${net.symbol}`);
        } catch (error) {
          lines.push(`${net.name}: ошибка`);
        }
      }
    } else {
      lines.push('');
      lines.push('EVM: EVM_PRIVATE_KEY не настроен.');
    }
  } catch (error) {
    lines.push('');
    lines.push(`EVM: ошибка проверки (${error.message})`);
  }

  return bot.sendMessage(chatId, lines.join('\n'));
}

function showHistory(chatId, userId) {
  const list = deployHistory.get(userId) || [];
  if (!list.length) {
    return bot.sendMessage(chatId, '📋 История пока пустая. Сделай первый деплой.');
  }

  const lines = ['📋 Последние деплои:'];
  list.forEach((item, idx) => {
    const date = new Date(item.time).toLocaleString('ru-RU');
    const icon = item.status === 'success' ? '✅' : '❌';
    lines.push('');
    lines.push(`${idx + 1}. ${icon} ${item.type.toUpperCase()} | ${date}`);
    lines.push(item.summary);
  });

  return bot.sendMessage(chatId, lines.join('\n'));
}

function showTemplateConfirm(chatId, type, template) {
  const paramsLines = Object.entries(template.params || {}).map(([k, v]) => `${k}: ${v}`);
  const text = [
    `Шаблон: ${template.name}`,
    template.description || '',
    '',
    'Параметры:',
    ...paramsLines,
    '',
    'Подтвердить деплой?'
  ].join('\n');

  return bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Деплоить', callback_data: `confirm_${type}_${template.id}` }],
        [{ text: '◀️ Назад', callback_data: `${type}_template` }]
      ]
    }
  });
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isUserAllowed(userId)) {
    return bot.sendMessage(chatId, '❌ У тебя нет доступа к этому боту.');
  }

  userSessions.delete(userId);
  return bot.sendMessage(
    chatId,
    '🚀 Crypto Deploy Bot\n\nРаботают 2 направления:\n• Solana через Metaplex\n• EVM через Foundry\n\nВыбери действие:',
    getMainMenu()
  );
});

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  userSessions.delete(userId);
  return bot.sendMessage(chatId, 'Сессия сброшена.', getMainMenu());
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (_) {
    // ignore
  }

  if (!isUserAllowed(userId)) {
    return bot.sendMessage(chatId, '❌ У тебя нет доступа к этому боту.');
  }

  if (data === 'back_main') {
    userSessions.delete(userId);
    return bot.editMessageText('🚀 Главное меню', {
      chat_id: chatId,
      message_id: messageId,
      ...getMainMenu()
    });
  }

  if (data === 'menu_metaplex') {
    return bot.editMessageText('🎨 Solana / Metaplex\n\nВыбери режим деплоя:', {
      chat_id: chatId,
      message_id: messageId,
      ...getSectionMenu('metaplex')
    });
  }

  if (data === 'menu_evm') {
    return bot.editMessageText('⚡ EVM Deploy\n\nВыбери режим деплоя:', {
      chat_id: chatId,
      message_id: messageId,
      ...getSectionMenu('evm')
    });
  }

  if (data === 'metaplex_template') {
    return bot.editMessageText('📝 Шаблоны Metaplex:', {
      chat_id: chatId,
      message_id: messageId,
      ...getTemplateList('metaplex')
    });
  }

  if (data === 'evm_template') {
    return bot.editMessageText('📝 Шаблоны EVM:', {
      chat_id: chatId,
      message_id: messageId,
      ...getTemplateList('evm')
    });
  }

  if (data === 'metaplex_custom') {
    userSessions.set(userId, { type: 'metaplex_custom', step: 'name', data: {} });
    return bot.sendMessage(chatId, 'Введи название токена:');
  }

  if (data === 'evm_custom') {
    userSessions.set(userId, { type: 'evm_custom', step: 'name', data: {} });
    return bot.sendMessage(chatId, 'Введи название токена:');
  }

  if (data === 'check_balance') {
    return checkBalances(chatId);
  }

  if (data === 'my_deploys') {
    return showHistory(chatId, userId);
  }

  if (data === 'help') {
    return bot.sendMessage(
      chatId,
      'ℹ️ Помощь\n\n1) Настрой .env\n- TELEGRAM_BOT_TOKEN\n- SOL_KEYPAIR\n- EVM_PRIVATE_KEY\n- ALLOWED_USERS (опционально)\n\n2) Запусти: npm start\n\nКоманда /cancel сбрасывает текущий ввод.'
    );
  }

  if (data.startsWith('template_')) {
    const [, type, ...rest] = data.split('_');
    const templateId = rest.join('_');
    const list = Array.isArray(templates[type]) ? templates[type] : [];
    const template = list.find(item => item.id === templateId);

    if (!template) {
      return bot.sendMessage(chatId, '❌ Шаблон не найден.');
    }

    return showTemplateConfirm(chatId, type, template);
  }

  if (data.startsWith('confirm_metaplex_')) {
    const templateId = data.replace('confirm_metaplex_', '');
    const template = (templates.metaplex || []).find(item => item.id === templateId);
    if (!template) return bot.sendMessage(chatId, '❌ Шаблон Metaplex не найден.');
    return deployMetaplex(chatId, userId, template.params || {});
  }

  if (data.startsWith('confirm_evm_')) {
    const templateId = data.replace('confirm_evm_', '');
    const template = (templates.evm || []).find(item => item.id === templateId);
    if (!template) return bot.sendMessage(chatId, '❌ Шаблон EVM не найден.');
    return deployEvm(chatId, userId, template.params || {});
  }

  if (data === 'confirm_metaplex_custom') {
    const session = userSessions.get(userId);
    if (!session || session.type !== 'metaplex_custom') {
      return bot.sendMessage(chatId, '❌ Сессия Metaplex не найдена.');
    }
    return deployMetaplex(chatId, userId, session.data);
  }

  if (data === 'confirm_evm_custom') {
    const session = userSessions.get(userId);
    if (!session || session.type !== 'evm_custom') {
      return bot.sendMessage(chatId, '❌ Сессия EVM не найдена.');
    }
    return deployEvm(chatId, userId, session.data);
  }
});

bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isUserAllowed(userId)) return;

  const session = userSessions.get(userId);
  if (!session) return;

  if (session.type === 'metaplex_custom') {
    if (session.step === 'name') {
      session.data.name = msg.text.trim();
      session.step = 'symbol';
      userSessions.set(userId, session);
      return bot.sendMessage(chatId, 'Введи символ токена:');
    }

    if (session.step === 'symbol') {
      session.data.symbol = msg.text.trim();
      session.step = 'tokens';
      userSessions.set(userId, session);
      return bot.sendMessage(chatId, 'Введи количество токенов (например: 1000000000):');
    }

    if (session.step === 'tokens') {
      session.data.tokens = msg.text.trim() === '1' ? '1000000000' : msg.text.trim();
      session.step = 'uri';
      userSessions.set(userId, session);
      return bot.sendMessage(chatId, 'Введи URI метадаты:');
    }

    if (session.step === 'uri') {
      session.data.uri = msg.text.trim();
      session.step = 'network';
      userSessions.set(userId, session);
      return bot.sendMessage(chatId, 'Сеть Solana? Напиши: mainnet или devnet');
    }

    if (session.step === 'network') {
      session.data.network = msg.text.trim().toLowerCase();
      session.data.decimals = 6;
      userSessions.set(userId, session);

      return bot.sendMessage(
        chatId,
        `Параметры Metaplex:\nname=${session.data.name}\nsymbol=${session.data.symbol}\ntokens=${session.data.tokens}\nuri=${session.data.uri}\nnetwork=${session.data.network}\n\nПодтвердить деплой?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Деплоить', callback_data: 'confirm_metaplex_custom' }],
              [{ text: '❌ Отмена', callback_data: 'back_main' }]
            ]
          }
        }
      );
    }
  }

  if (session.type === 'evm_custom') {
    if (session.step === 'name') {
      session.data.name = msg.text.trim();
      session.step = 'symbol';
      userSessions.set(userId, session);
      return bot.sendMessage(chatId, 'Введи символ токена:');
    }

    if (session.step === 'symbol') {
      session.data.symbol = msg.text.trim();
      session.step = 'decimals';
      userSessions.set(userId, session);
      return bot.sendMessage(chatId, 'Введи decimals (обычно 18):');
    }

    if (session.step === 'decimals') {
      session.data.decimals = msg.text.trim() || '18';
      session.step = 'network';
      userSessions.set(userId, session);

      return bot.sendMessage(chatId, 'Выбери сеть: ethereum / bsc / base');
    }

    if (session.step === 'network') {
      session.data.network = msg.text.trim().toLowerCase();
      userSessions.set(userId, session);

      return bot.sendMessage(
        chatId,
        `Параметры EVM:\nname=${session.data.name}\nsymbol=${session.data.symbol}\ndecimals=${session.data.decimals}\nnetwork=${session.data.network}\n\nПодтвердить деплой?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Деплоить', callback_data: 'confirm_evm_custom' }],
              [{ text: '❌ Отмена', callback_data: 'back_main' }]
            ]
          }
        }
      );
    }
  }
});

console.log('🤖 Bot started (Metaplex + EVM mode)...');
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});
