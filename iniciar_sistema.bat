@echo off
title Encante-se Trilhas - Servidor
echo ===================================================
echo Iniciando a plataforma Encante-se Trilhas...
echo ===================================================
echo.
echo Iniciando API + Frontend em paralelo...
echo O navegador sera aberto em http://localhost:5173
echo Mantenha esta janela aberta enquanto usa o sistema.
echo.
start "" http://localhost:5173
npm run dev
pause
