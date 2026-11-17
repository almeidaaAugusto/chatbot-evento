# Exclusao de dados do chatbot.
#
#   powershell -ExecutionPolicy Bypass -File scripts\limpar-dados.ps1 -Logs
#       Apaga os arquivos de log (volume do Docker e copias na pasta logs\).
#   ... -Estado
#       Apaga o estado do robo no Redis: mensagens ja vistas, contadores de limite e a
#       lista de contatos em atendimento humano (o robo volta a responder a todos).
#   ... -Tudo
#       Apaga TUDO: pareamento do WhatsApp, banco do n8n (workflows, credenciais,
#       execucoes com erro), estado do Redis e logs. Os conteineres sao removidos.
#       Depois disso, "docker compose up -d" recria o ambiente do zero.
#   Acrescente -Sim para nao pedir confirmacao.
param([switch]$Logs, [switch]$Estado, [switch]$Tudo, [switch]$Sim)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')
Set-Location (Get-Raiz)

if (-not ($Logs -or $Estado -or $Tudo)) {
    Write-Host 'Informe o que apagar: -Logs, -Estado ou -Tudo. Veja o comentario no inicio deste arquivo.'
    exit 1
}

function Confirm-Acao([string]$Pergunta) {
    if ($Sim) { return $true }
    return ((Read-Host "$Pergunta Digite SIM para confirmar") -eq 'SIM')
}

# Apaga as copias exportadas para a pasta logs\ do projeto (scripts\ver-logs.ps1 -Exportar).
function Remove-LogsExportados {
    $pasta = Join-Path (Get-Raiz) 'logs'
    @(Get-ChildItem -LiteralPath $pasta -Filter '*.log' -File -ErrorAction SilentlyContinue) | Remove-Item -Force
}

if ($Tudo) {
    if (-not (Confirm-Acao 'Isto apaga o pareamento do WhatsApp, o n8n, o Redis e os logs.')) { Write-Host 'Cancelado.'; exit 0 }
    Assert-Docker
    Invoke-Externo { docker compose down -v --remove-orphans } -Silencioso
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao remover os conteineres e volumes.' }
    Remove-LogsExportados
    Write-Host 'Tudo apagado. Para recriar: docker compose up -d'
    exit 0
}

if ($Logs) {
    Assert-Docker
    Invoke-Externo { docker compose run --rm --no-deps -T --entrypoint sh n8n-init -c 'rm -f /files/logs/*.log' } -Silencioso
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel apagar os logs no volume do Docker.' }
    Remove-LogsExportados
    Write-Host 'Logs apagados.'
}

if ($Estado) {
    if (-not (Confirm-Acao 'Isto apaga o estado do robo (inclusive quem esta em atendimento humano).')) { Write-Host 'Cancelado.'; exit 0 }
    Assert-Docker
    Invoke-Externo { docker compose exec -T redis redis-cli flushdb } -Silencioso
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel falar com o Redis. Os conteineres estao no ar?' }
    Write-Host 'Estado do robo apagado.'
}
