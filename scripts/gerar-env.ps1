# Cria o arquivo .env a partir de .env.example, com segredos aleatorios.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\gerar-env.ps1
#
# -Forcar recria o .env (o antigo vira .env.bak-AAAAMMDD-HHMMSS). ATENCAO: isso troca
# todas as chaves; o n8n deixa de ler as credenciais ja salvas e sera preciso
# reimportar (scripts\reimportar-workflows.ps1 -Tudo) e reconectar o painel do WAHA.
param([switch]$Forcar)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$modelo = Join-Path $raiz '.env.example'
$destino = Join-Path $raiz '.env'

if (-not (Test-Path -LiteralPath $modelo)) { throw "Arquivo nao encontrado: $modelo" }

if (Test-Path -LiteralPath $destino) {
    if (-not $Forcar) {
        Write-Host 'O arquivo .env ja existe. Nada foi alterado. (Use -Forcar para recriar.)'
        exit 0
    }
    $copia = "$destino.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $destino -Destination $copia
    Write-Host "Copia do .env anterior salva em $copia"
}

function New-Segredo([int]$Bytes = 24) {
    $buffer = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function Get-Sha512([string]$Texto) {
    $sha = [System.Security.Cryptography.SHA512]::Create()
    try { $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Texto)) } finally { $sha.Dispose() }
    return -join ($hash | ForEach-Object { $_.ToString('x2') })
}

$chaveWaha = New-Segredo 24
$linhas = Get-Content -LiteralPath $modelo -Encoding UTF8
$saida = foreach ($linha in $linhas) {
    if ($linha -match '^WAHA_API_KEY=') { "WAHA_API_KEY=$chaveWaha" }
    elseif ($linha -match '^WAHA_API_KEY_SHA512=') { "WAHA_API_KEY_SHA512=$(Get-Sha512 $chaveWaha)" }
    elseif ($linha -match '^WAHA_DASHBOARD_PASSWORD=__GERAR__\s*$') { "WAHA_DASHBOARD_PASSWORD=$(New-Segredo 12)" }
    elseif ($linha -match '^([A-Z0-9_]+)=__GERAR__\s*$') { "$($Matches[1])=$(New-Segredo 24)" }
    else { $linha }
}

[System.IO.File]::WriteAllLines($destino, [string[]]$saida, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Arquivo .env criado em $destino (os segredos nao sao exibidos; abra o arquivo se precisar deles)."
