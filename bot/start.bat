@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MeeTRPG bot

if not exist .env (
  echo .env がありません。README の手順で作成してください。
  pause
  exit /b 1
)
if not exist node_modules (
  echo 初回セットアップ中です。数分かかります...
  call npm install
  if errorlevel 1 (
    echo npm install に失敗しました。
    pause
    exit /b 1
  )
)

echo 起動します。この窓は閉じないでください(閉じるとbotが止まります)。
call npm run dev
echo.
echo botが停止しました。
pause
