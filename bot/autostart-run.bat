@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 卓日和bot(自動起動)
call npm run dev
