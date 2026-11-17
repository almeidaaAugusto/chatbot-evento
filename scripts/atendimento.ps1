# Contatos em atendimento humano (robo pausado para eles).
#
#   powershell -ExecutionPolicy Bypass -File scripts\atendimento.ps1
#       Lista quem pediu atendente e ate quando o robo fica pausado.
#   ... reativar 5500000000002     Reativa o robo para esse contato (pode ser so o final do numero).
#   ... reativar -Todos            Reativa o robo para todos.
#
# No dia a dia e mais pratico usar os comandos pelo proprio WhatsApp do evento:
# o atendente digita #bot na conversa para reativar, ou #humano para pausar.
param(
    [Parameter(Position = 0)][ValidateSet('listar', 'reativar')][string]$Acao = 'listar',
    [Parameter(Position = 1)][string]$Contato,
    [switch]$Todos
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')
Assert-Docker
Set-Location (Get-Raiz)

function Invoke-Redis {
    $argumentos = $args
    $saida = Invoke-Externo { docker compose exec -T redis redis-cli @argumentos }
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel falar com o Redis. Os conteineres estao no ar? Rode: docker compose up -d' }
    return $saida
}

$chaves = @(Invoke-Redis --scan --pattern 'pausa:*' | Where-Object { $_ -and $_.Trim() })

if ($Acao -eq 'listar') {
    if ($chaves.Count -eq 0) { Write-Host 'Nenhum contato em atendimento humano. O robo esta respondendo a todos.'; exit 0 }
    $linhas = foreach ($chave in $chaves) {
        $valor = [string](Invoke-Redis get $chave)
        $ttl = [int](Invoke-Redis ttl $chave)
        $partes = $valor -split '\|'
        $desde = $partes[0]
        try { $desde = ([datetime]$partes[0]).ToLocalTime().ToString('dd/MM HH:mm') } catch { }
        $origem = if ($partes.Count -gt 1 -and $partes[1] -eq 'operador') { 'comando #humano' } elseif ($partes.Count -gt 1 -and $partes[1] -eq 'atendente_respondeu') { 'equipe respondeu' } else { 'pediu atendente' }
        $restante = if ($ttl -gt 0) { '{0}h{1:00}' -f [int][math]::Floor($ttl / 3600), [int][math]::Floor(($ttl % 3600) / 60) } else { 'sem prazo' }
        [pscustomobject]@{ Contato = $chave.Substring(6); Desde = $desde; Motivo = $origem; 'Volta sozinho em' = $restante }
    }
    $linhas | Format-Table -AutoSize
    Write-Host 'Para reativar o robo: digite #bot na conversa pelo WhatsApp do evento, ou rode'
    Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\atendimento.ps1 reativar <numero>'
    exit 0
}

# --- reativar ---
if (-not $Todos -and -not $Contato) { throw 'Informe o numero do contato ou use -Todos.' }

$alvos = if ($Todos) { $chaves } else {
    $digitos = ($Contato -replace '\D', '')
    if ($digitos.Length -lt 4) { throw 'Informe pelo menos os 4 ultimos digitos do numero.' }
    @($chaves | Where-Object { (($_.Substring(6) -split '@')[0]).EndsWith($digitos) })
}

if ($alvos.Count -eq 0) { Write-Host 'Nenhum contato pausado corresponde a esse numero.'; exit 1 }
if (-not $Todos -and $alvos.Count -gt 1) {
    Write-Host 'Mais de um contato termina com esses digitos. Informe o numero completo:'
    $alvos | ForEach-Object { Write-Host "  $($_.Substring(6))" }
    exit 1
}

foreach ($chave in $alvos) {
    Invoke-Redis del $chave | Out-Null
    Write-Host "Robo reativado para $($chave.Substring(6))."
}
