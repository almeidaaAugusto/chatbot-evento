# Conecta um numero de WhatsApp ao WAHA por QR Code.
#
#   powershell -ExecutionPolicy Bypass -File scripts\conectar-whatsapp.ps1
#       Inicia a sessao, abre o QR Code no navegador e espera voce escanear.
#   ... -Status        So mostra a situacao da sessao.
#   ... -Parar         Para a sessao (o numero continua pareado; os contatos ficam sem resposta).
#   ... -Desconectar   Desfaz o pareamento (para trocar de numero).
#
# USE UM NUMERO DE TESTE. A integracao via WhatsApp Web nao e oficial e a conta pode
# sofrer restricoes. Nao use o numero principal do evento durante os testes.
param(
    [switch]$Status,
    [switch]$Parar,
    [switch]$Desconectar,
    [switch]$NaoAbrir,
    [int]$TempoMaximo = 300
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')

$sessao = 'default'

function Get-Sessao {
    $r = Invoke-Waha -Rota "/api/sessions/$sessao"
    if ($r.Status -eq 200) { return $r.Corpo }
    if ($r.Status -eq 404) { return $null }
    if ($r.Status -eq 401) { throw 'O WAHA recusou a chave da API (401). O .env foi alterado depois de subir os conteineres? Rode: docker compose up -d' }
    throw "Nao foi possivel falar com o WAHA (HTTP $($r.Status)). Os conteineres estao no ar? Rode: docker compose up -d"
}

function Show-Sessao($s) {
    if ($null -eq $s) { Write-Host 'Sessao ainda nao criada (nenhum numero conectado).'; return }
    Write-Host "Situacao da sessao: $($s.status)"
    if ($s.me -and $s.me.id) {
        $digitos = ($s.me.id -split '@')[0]
        $final = if ($digitos.Length -ge 4) { $digitos.Substring($digitos.Length - 4) } else { $digitos }
        Write-Host "Numero conectado: final $final ($($s.me.pushName))"
    }
}

$ping = Invoke-Waha -Rota '/ping'
if ($ping.Status -ne 200) { throw 'O WAHA nao esta respondendo. Rode: docker compose up -d  (e aguarde cerca de 1 minuto)' }

if ($Status) { Show-Sessao (Get-Sessao); exit 0 }

if ($Parar) {
    $r = Invoke-Waha -Metodo POST -Rota "/api/sessions/$sessao/stop"
    Write-Host "Sessao parada (HTTP $($r.Status))."
    exit 0
}

if ($Desconectar) {
    $resposta = Read-Host 'Isto desfaz o pareamento com o WhatsApp. Digite SIM para confirmar'
    if ($resposta -ne 'SIM') { Write-Host 'Cancelado.'; exit 0 }
    $r = Invoke-Waha -Metodo POST -Rota "/api/sessions/$sessao/logout"
    Write-Host "Pareamento removido (HTTP $($r.Status))."
    exit 0
}

# --- conectar ---

$atual = Get-Sessao
if ($null -eq $atual) {
    $r = Invoke-Waha -Metodo POST -Rota '/api/sessions' -Corpo @{ name = $sessao; start = $true }
    if ($r.Status -lt 200 -or $r.Status -ge 300) { throw "Falha ao criar a sessao (HTTP $($r.Status))." }
    Write-Host 'Sessao criada.'
} elseif ($atual.status -eq 'WORKING') {
    Write-Host 'O WhatsApp ja esta conectado.'
    Show-Sessao $atual
    exit 0
} elseif ($atual.status -eq 'FAILED') {
    Invoke-Waha -Metodo POST -Rota "/api/sessions/$sessao/restart" | Out-Null
} elseif ($atual.status -eq 'STOPPED') {
    Invoke-Waha -Metodo POST -Rota "/api/sessions/$sessao/start" | Out-Null
}

$pasta = Join-Path $env:TEMP 'chatbot-evento-qr'
New-Item -ItemType Directory -Force -Path $pasta | Out-Null
$imagem = Join-Path $pasta 'qr.png'
$pagina = Join-Path $pasta 'conectar.html'

function Write-Pagina([string]$Corpo, [bool]$Atualizar) {
    $meta = if ($Atualizar) { '<meta http-equiv="refresh" content="4">' } else { '' }
    $html = "<!doctype html><html><head><meta charset=`"utf-8`">$meta<title>Conectar WhatsApp - Chatbot do evento</title></head>" +
            "<body style=`"font-family:Segoe UI,Arial,sans-serif;text-align:center;margin-top:40px`">$Corpo</body></html>"
    [System.IO.File]::WriteAllText($pagina, $html, (New-Object System.Text.UTF8Encoding($false)))
}

$instrucoes = '<h2>Escaneie com o WhatsApp do n&uacute;mero de TESTE</h2>' +
              '<p>No celular: WhatsApp &gt; Dispositivos conectados &gt; Conectar dispositivo</p>' +
              '<img id="q" width="380" alt="QR Code"><script>document.getElementById("q").src="qr.png?"+Date.now()</script>' +
              '<p style="color:#666">Esta p&aacute;gina se atualiza sozinha. O c&oacute;digo muda a cada 20 a 60 segundos.</p>'

Write-Host ''
Write-Host 'USE UM NUMERO DE TESTE, nao o numero principal do evento.'
Write-Host "Aguardando o QR Code (limite de $TempoMaximo segundos)..."

$inicio = Get-Date
$aberto = $false
$reinicios = 0
$conectado = $false

while (((Get-Date) - $inicio).TotalSeconds -lt $TempoMaximo) {
    $s = Get-Sessao
    $situacao = if ($s) { $s.status } else { 'INEXISTENTE' }

    if ($situacao -eq 'WORKING') { $conectado = $true; break }

    if ($situacao -eq 'SCAN_QR_CODE') {
        $r = Invoke-Waha -Rota "/api/$sessao/auth/qr?format=image" -ArquivoSaida $imagem
        if ($r.Status -eq 200 -and -not $aberto) {
            Write-Pagina $instrucoes $true
            $aberto = $true
            Write-Host "QR Code pronto: $pagina"
            if (-not $NaoAbrir) { Start-Process $pagina }
        }
    } elseif ($situacao -eq 'FAILED') {
        # Os QR Codes expiraram sem leitura: reinicia para gerar novos.
        $reinicios += 1
        if ($reinicios -gt 5) { break }
        Invoke-Waha -Metodo POST -Rota "/api/sessions/$sessao/restart" | Out-Null
    } elseif ($situacao -eq 'STOPPED') {
        Invoke-Waha -Metodo POST -Rota "/api/sessions/$sessao/start" | Out-Null
    }
    Start-Sleep -Seconds 3
}

if ($conectado) {
    Write-Pagina '<h2>WhatsApp conectado!</h2><p>Pode fechar esta p&aacute;gina.</p>' $false
    Remove-Item -LiteralPath $imagem -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host 'WhatsApp conectado. O chatbot ja esta respondendo.'
    Show-Sessao (Get-Sessao)
    exit 0
}

# Nao conectou: para a sessao para nao ficar gerando QR Codes sem ninguem olhando.
Invoke-Waha -Metodo POST -Rota "/api/sessions/$sessao/stop" | Out-Null
Write-Pagina '<h2>Tempo esgotado</h2><p>Rode o script de novo para gerar outro QR Code.</p>' $false
Remove-Item -LiteralPath $imagem -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'O QR Code nao foi escaneado a tempo. A sessao foi parada; rode o script de novo quando quiser conectar.'
exit 1
