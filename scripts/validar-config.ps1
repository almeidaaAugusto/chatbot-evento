# Confere se config\chatbot.json esta correto (JSON valido, opcoes completas, palavras repetidas...).
# Rode sempre depois de editar o arquivo:
#   powershell -ExecutionPolicy Bypass -File scripts\validar-config.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')
Assert-Docker
Set-Location (Get-Raiz)

Invoke-Externo { docker compose run --rm --no-deps -T --entrypoint node n8n-init /init/validar-config.js /files/config/chatbot.json }
exit $LASTEXITCODE
