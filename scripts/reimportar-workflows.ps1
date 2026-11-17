# Reimporta no n8n os workflows de n8n\workflows\ (e, opcionalmente, as credenciais do .env).
#
#   powershell -ExecutionPolicy Bypass -File scripts\reimportar-workflows.ps1
#       Reimporta e republica os workflows.
#   ... -Credenciais   Reimporta so as credenciais (depois de trocar chaves no .env).
#   ... -Tudo          Credenciais e workflows.
#
# ATENCAO: reimportar workflows SOBRESCREVE alteracoes feitas pela tela do n8n
# nos dois workflows do chatbot. A configuracao em config\chatbot.json nao e afetada.
param([switch]$Credenciais, [switch]$Tudo)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')
Assert-Docker
Set-Location (Get-Raiz)

$modo = 'workflows'
if ($Tudo) { $modo = 'tudo' } elseif ($Credenciais) { $modo = 'credenciais' }

Write-Host "Parando o n8n e reimportando ($modo)..."
Invoke-Externo { docker compose stop n8n } -Silencioso
Invoke-Externo { docker compose run --rm -e "IMPORTAR=$modo" n8n-init } -Completo
if ($LASTEXITCODE -ne 0) { throw 'A importacao falhou. Veja as mensagens acima.' }
Invoke-Externo { docker compose up -d } -Silencioso
if ($LASTEXITCODE -ne 0) { throw 'Falha ao subir os conteineres. Rode: docker compose up -d' }
Write-Host 'Pronto. O chatbot volta a responder em cerca de 1 minuto.'
