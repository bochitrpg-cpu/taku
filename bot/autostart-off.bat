@echo off
chcp 65001 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\meetrpg-bot.lnk" 2>nul
echo 自動起動を解除しました。
pause
