@echo off
cd /d "%~dp0"
set DEMO_MODE=true
set PRODUCT_CATALOG_PATH=data/product_catalog.json
set WHATSAPP_DATA_DIR=data
set WHATSAPP_ASSETS_DIR=assets
set WHATSAPP_STORE=sqlite
set WHATSAPP_SQLITE_PATH=agent.sqlite
"C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.mjs >> server.out.log 2>> server.err.log
