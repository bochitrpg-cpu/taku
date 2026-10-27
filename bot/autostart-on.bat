@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Windowsにログインしたとき、botを最小化した窓で自動起動する
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\meetrpg-bot.lnk'); $s.TargetPath='%~dp0autostart-run.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (
  echo 設定に失敗しました。
) else (
  echo 設定しました。次回からWindowsにログインすると、botが自動で起動します。
)
pause
