# Liga o assistente de IA usado quando o robo nao entende a mensagem.
#
#   powershell -ExecutionPolicy Bypass -File scripts\configurar-ia.ps1
#       Pede a chave da API (nao aparece na tela), grava no .env, testa com uma pergunta
#       real e, se funcionar, liga a IA e atualiza a credencial no n8n.
#   ... -Status      Mostra se a IA esta ligada, o provedor e os limites (sem chamar a API).
#   ... -Desligar    Desliga a IA (as orientacoes normais continuam). A chave fica no .env.
#   ... -Testar      Testa de novo a chave que ja esta no .env.
#
# Chave gratuita da Groq (comeca com gsk_): https://console.groq.com/keys
# Tambem aceita chave da xAI / Grok (comeca com xai-), que e paga.
param([switch]$Status, [switch]$Desligar, [switch]$Testar)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')
Assert-Docker
Set-Location (Get-Raiz)

function Invoke-Ajudante([string]$Acao) {
    Invoke-Externo { docker compose run --rm --no-deps -T --entrypoint node painel /app/painel/configurar-ia.js $Acao } -Completo |
        Where-Object { $_ -notmatch '^\s*(Container|Network|Volume) ' } | ForEach-Object { Write-Host $_ }
    return $LASTEXITCODE
}

if ($Status) { exit (Invoke-Ajudante 'status') }
if ($Desligar) { exit (Invoke-Ajudante 'desligar') }

$caminhoEnv = Join-Path (Get-Raiz) '.env'
if (-not $Testar) {
    Write-Host 'Crie uma chave gratuita em https://console.groq.com/keys (login com Google ou e-mail),'
    Write-Host 'clique em "Create API Key" e copie a chave (comeca com gsk_).'
    $segura = Read-Host 'Cole a chave aqui e tecle Enter (ela nao aparece na tela)' -AsSecureString
    $ponteiro = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura)
    try { $chave = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ponteiro).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ponteiro) }
    if (-not $chave) { Write-Host 'Nenhuma chave informada. Nada foi alterado.'; exit 1 }
    if ($chave -notmatch '^[A-Za-z0-9_\-\.]{20,}$') { Write-Host 'Isso nao parece uma chave de API (so letras, numeros, _ e -). Nada foi alterado.'; exit 1 }

    # Grava IA_API_KEY no .env, preservando as demais linhas (UTF-8 sem BOM).
    $linhas = @(Get-Content -LiteralPath $caminhoEnv -Encoding UTF8)
    $achou = $false
    $novas = foreach ($linha in $linhas) {
        if ($linha -match '^\s*IA_API_KEY\s*=') { $achou = $true; "IA_API_KEY=$chave" } else { $linha }
    }
    if (-not $achou) { $novas = @($novas) + '' + '# Chave da API de IA (scripts\configurar-ia.ps1).' + "IA_API_KEY=$chave" }
    [System.IO.File]::WriteAllLines($caminhoEnv, [string[]]$novas, (New-Object System.Text.UTF8Encoding($false)))
    $chave = $null
    Write-Host 'Chave gravada no .env.'
}

Write-Host ''
$codigo = Invoke-Ajudante 'ligar'
if ($codigo -ne 0) {
    Write-Host ''
    Write-Host 'A IA nao foi ligada. Corrija o problema acima e rode este script de novo.'
    exit $codigo
}

Write-Host ''
Write-Host 'Atualizando a credencial da IA no n8n (o robo fica fora do ar por cerca de 1 minuto)...'
& (Join-Path $PSScriptRoot 'reimportar-workflows.ps1') -Credenciais
Write-Host 'Pronto: quando o robo nao entender uma mensagem, a IA tenta responder.'
Write-Host 'Para ajustar limites e informacoes da IA, use o painel (http://localhost:8080, secao 05).'
