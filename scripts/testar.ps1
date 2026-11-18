# Roda os testes SIMULADOS do chatbot em um ambiente isolado (nao toca no ambiente real
# nem no WhatsApp). Sobe n8n + Redis + um WAHA simulado, dispara mensagens de teste,
# confere as respostas e depois apaga tudo.
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\testar.ps1
#       -Manter  deixa o ambiente de teste no ar ao final (para investigar falhas).
param([switch]$Manter)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')
if ($script:ModoVps) { Write-Host 'testar.ps1 so vale no PC (usa um ambiente de teste local).'; exit 1 }
Assert-Docker

$compose = Join-Path (Get-Raiz) 'tests\docker-compose.test.yml'

Write-Host 'Conferindo interpretacao, painel e workflow...'
Invoke-Externo { docker compose -f $compose run --rm --no-deps testes-locais }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Preparando o ambiente de teste (cerca de 1 minuto)...'
Invoke-Externo { docker compose -f $compose down -v --remove-orphans } -Silencioso

Invoke-Externo { docker compose -f $compose up -d --quiet-pull redis waha preparar-logs n8n-init n8n painel } -Silencioso
if ($LASTEXITCODE -ne 0) {
    Invoke-Externo { docker compose -f $compose ps -a } -Completo
    Invoke-Externo { docker compose -f $compose logs --tail 40 n8n-init n8n } -Completo
    throw 'Falha ao subir o ambiente de teste.'
}

Invoke-Externo { docker compose -f $compose run --rm testes }
$codigo = $LASTEXITCODE

if ($Manter) {
    Write-Host "Ambiente de teste mantido. Para apagar: docker compose -f `"$compose`" down -v"
} else {
    Invoke-Externo { docker compose -f $compose down -v --remove-orphans } -Silencioso
}

exit $codigo
