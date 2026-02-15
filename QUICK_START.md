# Быстрый старт

```bash
cd telegram-bot-unified
npm install
cp .env.example .env
```

Заполни `.env`:

```env
TELEGRAM_BOT_TOKEN=токен_бота
SOL_KEYPAIR=/полный/путь/к/keypair.json
EVM_PRIVATE_KEY=0x...
# ALLOWED_USERS=123456789
```

Запуск:

```bash
npm start
```

В Telegram:
1. `/start`
2. Выбери `Solana (Metaplex)` или `EVM Token Deploy`
3. Либо шаблон, либо кастомный ввод
4. Подтверди деплой

Сброс текущего ввода:

```text
/cancel
```
