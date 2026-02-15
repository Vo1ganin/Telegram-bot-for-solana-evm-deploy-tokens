# Telegram Bot Unified (Metaplex + EVM)

Telegram-бот для деплоя токенов из одного интерфейса:
- Solana через `../metaplex-mint/mint_via_metaplex.js`
- EVM через `../evm-token-cli` (Foundry)

## Коротко

- Проект: Telegram-бот для запуска деплоя токенов в Solana и EVM из одного интерфейса.
- Что сделал: объединил два отдельных CLI-проекта в единый UX с кнопками, шаблонами, проверкой балансов и историей деплоев.
- Стек: Node.js, Telegram Bot API, Solana CLI, Foundry (forge), ethers.js.
- Результат: один вход (`/start`) и управляемый процесс деплоя без ручного запуска скриптов по разным папкам.

## Требования

- Node.js 18+
- `solana` CLI
- `forge` (Foundry)
- Соседние папки:
  - `../metaplex-mint`
  - `../evm-token-cli`

## Настройка

```bash
cd telegram-bot-unified
npm install
cp .env.example .env
```

Заполни `.env`:

```env
TELEGRAM_BOT_TOKEN=...
SOL_KEYPAIR=/absolute/path/to/solana-keypair.json
EVM_PRIVATE_KEY=0x...
# ALLOWED_USERS=123456789
```

## Запуск

```bash
npm start
```

Проверка синтаксиса:

```bash
npm run check
```

## Шаблоны

По умолчанию `templates.json` пустой. Добавляй свои шаблоны в формате:

```json
{
  "metaplex": [
    {
      "id": "meta_mainnet_default",
      "name": "Metaplex Mainnet",
      "description": "Стандартный SPL токен",
      "params": {
        "name": "My Solana Token",
        "symbol": "MST",
        "decimals": 6,
        "tokens": "1000000",
        "uri": "https://example.com/metadata.json",
        "network": "mainnet"
      }
    }
  ],
  "evm": [
    {
      "id": "evm_eth_default",
      "name": "EVM Ethereum",
      "description": "ERC20 в Ethereum",
      "params": {
        "name": "My EVM Token",
        "symbol": "MET",
        "decimals": 18,
        "network": "ethereum"
      }
    }
  ]
}
```

## Безопасность

- Не коммить `.env`
- Не коммить приватные ключи
- В публичный GitHub добавляй только `.env.example`
