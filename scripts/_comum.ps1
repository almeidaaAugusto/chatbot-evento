# Funcoes compartilhadas pelos scripts desta pasta. Nao execute este arquivo diretamente.
#
# Os arquivos .ps1 deste projeto nao usam acentos de proposito: o Windows PowerShell 5.1
# le arquivos sem BOM como ANSI e trocaria os caracteres acentuados.

$script:Raiz = Split-Path -Parent $PSScriptRoot

# Os conteineres escrevem em UTF-8; sem isto os acentos aparecem trocados no terminal.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Get-Raiz { return $script:Raiz }

# ---------------------------------------------------------------------------------------------
# Modo VPS: com a variavel de ambiente CHATBOT_VPS=1 (definida por scripts\vps.ps1 -Script), os
# comandos "docker ..." dos scripts sao executados no servidor, por SSH, e o .env lido e o do
# servidor. Os scripts nao precisam mudar. Dados do servidor: deploy\vps.local.json.
# ---------------------------------------------------------------------------------------------
$script:ModoVps = ($env:CHATBOT_VPS -eq '1')
$script:VpsConfig = $null
$script:EnvVps = $null
$script:TunelOk = $false
$script:TunelProprio = $null

# Prefere o OpenSSH do Windows (o ssh/scp do Git for Windows pode vir antes no PATH e se comporta diferente).
$script:Ssh = 'ssh'
$script:Scp = 'scp'
if ($env:SystemRoot) {
    $__dirSsh = Join-Path $env:SystemRoot 'System32\OpenSSH'
    if (Test-Path -LiteralPath (Join-Path $__dirSsh 'ssh.exe')) { $script:Ssh = Join-Path $__dirSsh 'ssh.exe' }
    if (Test-Path -LiteralPath (Join-Path $__dirSsh 'scp.exe')) { $script:Scp = Join-Path $__dirSsh 'scp.exe' }
}

# Entre aspas simples para o bash, com escape de aspas simples dentro do texto.
function ConvertTo-BashArg([string]$Texto) {
    return "'" + $Texto.Replace("'", "'\''") + "'"
}

# Le deploy\vps.local.json e devolve Host, Usuario, Chave (caminho completo) e Pasta.
function Get-VpsConfig {
    if ($script:VpsConfig) { return $script:VpsConfig }
    $caminho = Join-Path $script:Raiz 'deploy\vps.local.json'
    if (-not (Test-Path -LiteralPath $caminho)) {
        throw 'Servidor nao configurado. Rode: powershell -ExecutionPolicy Bypass -File scripts\vps.ps1 -Configurar -Servidor <IP>'
    }
    $j = Get-Content -LiteralPath $caminho -Raw -Encoding UTF8 | ConvertFrom-Json
    $servidor = [string]$j.host
    $usuario = if ($j.usuario) { [string]$j.usuario } else { 'ubuntu' }
    $pasta = if ($j.pasta) { [string]$j.pasta } else { 'chatbot-evento' }
    $chave = if ($j.chave) { [string]$j.chave } else { '~/.ssh/oracle_chatbot' }
    if ($servidor -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]*$') { throw 'deploy\vps.local.json: "host" invalido.' }
    if ($usuario -notmatch '^[A-Za-z_][A-Za-z0-9._-]*$') { throw 'deploy\vps.local.json: "usuario" invalido.' }
    if ($pasta -notmatch '^[A-Za-z0-9._/-]+$') { throw 'deploy\vps.local.json: "pasta" invalida (use letras, numeros, ponto, hifen e barra).' }
    if ($chave -eq '~') { $chave = $env:USERPROFILE } elseif ($chave -match '^~[\\/]') { $chave = Join-Path $env:USERPROFILE $chave.Substring(2) }
    if (-not (Test-Path -LiteralPath $chave)) { throw "Chave SSH nao encontrada: $chave" }
    $script:VpsConfig = [pscustomobject]@{ Host = $servidor; Usuario = $usuario; Chave = $chave; Pasta = $pasta }
    return $script:VpsConfig
}

# Opcoes comuns do ssh e do scp.
function Get-VpsOpcoes {
    $c = Get-VpsConfig
    return @('-i', $c.Chave, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')
}

# Executa um comando bash no servidor. O texto vai em base64 e e lido pelo bash por substituicao
# de processo: assim nenhuma aspa, espaco ou acento passa pela linha de comando do Windows e o
# stdin do ssh fica livre para receber dados (ex.: "texto | Invoke-VpsSsh ..."). O codigo de
# saida do comando fica em $LASTEXITCODE.
function Invoke-VpsSsh {
    param([string]$Comando)
    $c = Get-VpsConfig
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Comando))
    $remoto = "exec bash <(printf %s $b64 | base64 -d)"
    $a = @(Get-VpsOpcoes) + @('-T', "$($c.Usuario)@$($c.Host)", $remoto)
    if ($MyInvocation.ExpectingInput) { $input | & $script:Ssh @a } else { & $script:Ssh @a }
}

# Copia um arquivo do PC para o servidor (destino relativo a pasta pessoal do usuario).
function Copy-ParaVps([string]$Local, [string]$Remoto) {
    $c = Get-VpsConfig
    $local_ = (Resolve-Path -LiteralPath $Local).Path
    Push-Location (Split-Path -Parent $local_)   # evita que "C:\..." seja lido como "host:caminho"
    try {
        Invoke-Externo { & $script:Scp @(Get-VpsOpcoes) (Split-Path -Leaf $local_) "$($c.Usuario)@$($c.Host):$Remoto" } -Silencioso
    } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Falha ao enviar $Local para o servidor." }
}

# Copia um arquivo (ou pasta, com -Recursivo) do servidor para o PC. O destino e o nome final.
function Copy-DaVps([string]$Remoto, [string]$Local, [switch]$Recursivo) {
    $c = Get-VpsConfig
    $pai = Split-Path -Parent $Local
    if ($pai -and -not (Test-Path -LiteralPath $pai)) { New-Item -ItemType Directory -Force -Path $pai | Out-Null }
    $pai = if ($pai) { (Resolve-Path -LiteralPath $pai).Path } else { (Get-Location).Path }
    Push-Location $pai
    try {
        $extra = if ($Recursivo) { @('-r') } else { @() }
        Invoke-Externo { & $script:Scp @extra @(Get-VpsOpcoes) "$($c.Usuario)@$($c.Host):$Remoto" (Split-Path -Leaf $Local) } -Silencioso
    } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Falha ao baixar $Remoto do servidor." }
}

# Portas do tunel: as mesmas do servidor (do .env dele) abertas no PC.
function Get-VpsPortas {
    try { $e = Read-DotEnv -Servidor } catch { $e = @{} }
    $p = if ($e['PAINEL_PORT']) { $e['PAINEL_PORT'] } else { '8080' }
    $w = if ($e['WAHA_PORT']) { $e['WAHA_PORT'] } else { '3000' }
    $n = if ($e['N8N_PORT']) { $e['N8N_PORT'] } else { '5678' }
    return [pscustomobject]@{ Painel = [int]$p; Waha = [int]$w; N8n = [int]$n }
}

function Test-PortaLocal([int]$Porta) {
    $cliente = New-Object System.Net.Sockets.TcpClient
    try {
        $espera = $cliente.BeginConnect('127.0.0.1', $Porta, $null, $null)
        if (-not $espera.AsyncWaitHandle.WaitOne(1000)) { return $false }
        $cliente.EndConnect($espera)
        return $true
    } catch { return $false } finally { $cliente.Close() }
}

# Processo ssh do tunel para este servidor (aberto por este ou por outro terminal), ou $null.
function Get-TunelVps {
    $c = Get-VpsConfig
    $porta = (Get-VpsPortas).Waha
    $achados = @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*127.0.0.1:${porta}:127.0.0.1:${porta}*" -and $_.CommandLine -like "*$($c.Usuario)@$($c.Host)*" })
    if ($achados.Count -gt 0) { return $achados[0] }
    return $null
}

# Abre o tunel SSH em segundo plano (painel, WAHA e n8n). Devolve o processo que abriu, ou $null
# se ja existia um tunel para este servidor. Falha se as portas locais estiverem ocupadas por
# outra coisa (ex.: o robo local ligado): assim nunca se fala com o WAHA errado.
function Open-TunelVps {
    $c = Get-VpsConfig
    $p = Get-VpsPortas
    if (Get-TunelVps) { return $null }
    foreach ($porta in @($p.Painel, $p.Waha, $p.N8n)) {
        if (Test-PortaLocal $porta) {
            throw "A porta $porta deste computador ja esta em uso (o robo local esta ligado? Rode: docker compose down). O tunel nao foi aberto."
        }
    }
    $argumentos = @(Get-VpsOpcoes) + @('-N', '-o', 'ExitOnForwardFailure=yes')
    foreach ($porta in @($p.Painel, $p.Waha, $p.N8n)) { $argumentos += @('-L', "127.0.0.1:${porta}:127.0.0.1:${porta}") }
    $argumentos += "$($c.Usuario)@$($c.Host)"
    $texto = ($argumentos | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $proc = Start-Process -FilePath $script:Ssh -ArgumentList $texto -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if ($proc.HasExited) { throw 'O tunel SSH nao abriu. Confira a conexao com o servidor (vps.ps1 -Status).' }
        if (Test-PortaLocal $p.Waha) { return $proc }
    }
    try { $proc.Kill() } catch { }
    throw 'O tunel SSH nao ficou pronto a tempo.'
}

function Stop-TunelVps($Processo) {
    if ($Processo) { try { $Processo.Kill() } catch { } }
}

# Garante o tunel para Invoke-Waha; se foi aberto aqui, um vigia o encerra quando este PowerShell terminar.
function Initialize-TunelVps {
    if ($script:TunelOk) { return }
    $proc = Open-TunelVps
    if ($proc) {
        $script:TunelProprio = $proc
        # O evento PowerShell.Exiting nao e confiavel com "-File": um vigia escondido espera este processo
        # terminar (por qualquer motivo) e fecha o tunel.
        $vigia = "Wait-Process -Id $PID -ErrorAction SilentlyContinue; Stop-Process -Id $($proc.Id) -Force -ErrorAction SilentlyContinue"
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-Command', $vigia) -WindowStyle Hidden | Out-Null
    }
    $script:TunelOk = $true
}

if ($script:ModoVps) {
    # Funcao tem prioridade sobre o executavel: todo "docker ..." dos scripts passa a rodar no
    # servidor, na pasta do projeto. Cada argumento vai entre aspas simples para o bash.
    function docker {
        $c = Get-VpsConfig
        $partes = foreach ($a in $args) { ConvertTo-BashArg ([string]$a) }
        $cmd = 'cd ' + (ConvertTo-BashArg $c.Pasta) + ' && docker ' + ($partes -join ' ')
        if ($MyInvocation.ExpectingInput) { $input | Invoke-VpsSsh $cmd } else { Invoke-VpsSsh $cmd }
    }
}

# Converte as linhas de um .env em uma tabela NOME -> valor.
function ConvertFrom-DotEnvLinhas($linhas) {
    $valores = @{}
    foreach ($linha in $linhas) {
        if ($linha -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $valores[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
        }
    }
    return $valores
}

# Le o arquivo .env da raiz do projeto e devolve uma tabela NOME -> valor.
# Em modo VPS (veja abaixo), le o .env do SERVIDOR, porque as chaves la sao outras.
function Read-DotEnv {
    param([switch]$Servidor)
    if ($script:ModoVps -or $Servidor) {
        if (-not $script:EnvVps) {
            $saida = @(Invoke-VpsSsh ('cd ' + (ConvertTo-BashArg (Get-VpsConfig).Pasta) + ' && cat .env'))
            if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel ler o .env do servidor. Ja rodou "vps.ps1 -Enviar"?' }
            $script:EnvVps = ConvertFrom-DotEnvLinhas ($saida | ForEach-Object { "$_" })
        }
        return $script:EnvVps
    }
    $caminho = Join-Path $script:Raiz '.env'
    if (-not (Test-Path -LiteralPath $caminho)) {
        throw 'Arquivo .env nao encontrado. Rode primeiro: powershell -ExecutionPolicy Bypass -File scripts\gerar-env.ps1'
    }
    return (ConvertFrom-DotEnvLinhas (Get-Content -LiteralPath $caminho -Encoding UTF8))
}

# Executa um comando externo (docker...) sem que o Windows PowerShell 5.1 trate como erro
# o que o comando escreve em stderr (o Docker escreve ali as mensagens de progresso).
# Devolve a saida normal do comando. -Silencioso nao devolve nada; -Completo inclui tambem
# as mensagens de progresso/erro. Confira o resultado em $LASTEXITCODE.
#
# Os nomes internos tem prefixo "__" de proposito: o bloco recebido enxerga as variaveis
# desta funcao, e um nome comum (como $comando) esconderia a variavel de quem chamou.
function Invoke-Externo {
    param([Parameter(Mandatory = $true, Position = 0)][scriptblock]$__Bloco, [switch]$Silencioso, [switch]$Completo)
    $__preferenciaAnterior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Silencioso) { & $__Bloco *> $null }
        elseif ($Completo) { & $__Bloco 2>&1 | ForEach-Object { "$_" } }
        else { & $__Bloco 2> $null }
    } finally {
        $ErrorActionPreference = $__preferenciaAnterior
    }
}

function Assert-Docker {
    Invoke-Externo { docker info --format '{{.ServerVersion}}' } -Silencioso
    if ($LASTEXITCODE -ne 0) { throw 'O Docker nao esta respondendo. Abra o Docker Desktop e tente de novo.' }
}

# Chama a API do WAHA local. Devolve um objeto com .Status (codigo HTTP) e .Corpo.
function Invoke-Waha {
    param(
        [string]$Metodo = 'GET',
        [Parameter(Mandatory = $true)][string]$Rota,
        $Corpo = $null,
        [string]$ArquivoSaida = $null
    )
    $env_ = Read-DotEnv
    $porta = if ($env_['WAHA_PORT']) { $env_['WAHA_PORT'] } else { '3000' }
    if ($script:ModoVps) { Initialize-TunelVps }
    $parametros = @{
        Method          = $Metodo
        Uri             = "http://127.0.0.1:$porta$Rota"
        Headers         = @{ 'X-Api-Key' = $env_['WAHA_API_KEY'] }
        UseBasicParsing = $true
        TimeoutSec      = 30
    }
    if ($null -ne $Corpo) {
        $parametros['ContentType'] = 'application/json'
        $parametros['Body'] = [System.Text.Encoding]::UTF8.GetBytes(($Corpo | ConvertTo-Json -Depth 10 -Compress))
    }
    if ($ArquivoSaida) {
        $parametros['OutFile'] = $ArquivoSaida
        $parametros['PassThru'] = $true   # sem isto o PowerShell nao devolve o codigo HTTP
        $parametros['Headers']['Accept'] = 'image/png'
    }
    try {
        $resposta = Invoke-WebRequest @parametros
        $conteudo = $null
        if (-not $ArquivoSaida -and $resposta.Content) {
            try { $conteudo = $resposta.Content | ConvertFrom-Json } catch { $conteudo = $resposta.Content }
        }
        return [pscustomobject]@{ Status = [int]$resposta.StatusCode; Corpo = $conteudo }
    } catch {
        $codigo = 0
        if ($_.Exception.Response) { $codigo = [int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{ Status = $codigo; Corpo = $null; Erro = $_.Exception.Message }
    }
}
