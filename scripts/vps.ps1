# Administra o chatbot rodando na VPS (Oracle) a partir deste computador. Guia: docs\vps-oracle.md
#
#   powershell -ExecutionPolicy Bypass -File scripts\vps.ps1 <acao>
#
#   -Configurar -Servidor <ip>   Cria deploy\vps.local.json (ignorado pelo git) e testa o SSH.
#                                (Opcionais: -Usuario ubuntu, -Chave ~/.ssh/oracle_chatbot, -Pasta chatbot-evento)
#   -Instalar                    Envia e roda deploy\preparar-servidor.sh no servidor (uma vez).
#   -Enviar [-SobrescreverEnv]   Envia o ultimo commit (git archive HEAD) e sobe os conteineres.
#                                Nunca sobrescreve config\chatbot.json do servidor se ele ja existir.
#                                O .env so vai se nao existir no servidor (ou com -SobrescreverEnv).
#   -Tunel                       Abre o tunel SSH (painel, WAHA, n8n) e fica aberto ate Ctrl+C.
#   -Script <nome> [-Argumentos ...]   Roda scripts\<nome>.ps1 apontando para a VPS (modo VPS).
#                                Ex.: -Script conectar-whatsapp   |   -Script ver-logs -Argumentos '-Erros'
#                                Varios argumentos: -Argumentos '-Linhas 100'. Se o argumento for -Status, -Parar ou
#                                -Tunel, use a forma com dois pontos: -Argumentos:-Status
#   -Status                      docker compose ps, disco e memoria do servidor.
#   -Parar                       docker compose down no servidor (os dados ficam nos volumes).
#   -BaixarConfig                Copia config\chatbot.json do servidor para este computador.
#   -Backup                      Baixa config, .env e o pareamento do WhatsApp para backups\vps-AAAA-MM-DD-HHMM\.
#   -SenhaPainel                 Pede usuario e senha (minimo 12 caracteres, digitada sem aparecer) do painel online,
#                                grava so o hash no .env do servidor e reinicia o painel. Faca ANTES de -Online.
#   -Online [-Dominio <dominio>] Abre o painel na internet com HTTPS: firewall do servidor (80/443), Caddy e login.
#                                Sem -Dominio usa <ip-com-tracos>.sslip.io (so se o servidor for um IP).
#                                Antes: -Enviar, -SenhaPainel e a Security List da Oracle (80 e 443).
#   -OnlineDesligar              Desliga o acesso pela internet (para o Caddy); o painel volta a ser so por tunel.
param(
    [switch]$Configurar,
    [Alias('Host')][string]$Servidor,
    [string]$Usuario = 'ubuntu',
    [string]$Chave = '~/.ssh/oracle_chatbot',
    [string]$Pasta = 'chatbot-evento',
    [switch]$Instalar,
    [switch]$Enviar,
    [switch]$SobrescreverEnv,
    [switch]$Tunel,
    [string]$Script,
    [string[]]$Argumentos = @(),
    [switch]$Status,
    [switch]$Parar,
    [switch]$BaixarConfig,
    [switch]$Backup,
    [switch]$SenhaPainel,
    [switch]$Online,
    [string]$Dominio,
    [switch]$OnlineDesligar
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')
$raiz = Get-Raiz
$imagemArm = 'gows-arm-2026.10.1'

$acoes = @($Configurar, $Instalar, $Enviar, $Tunel, [bool]$Script, $Status, $Parar, $BaixarConfig, $Backup, $SenhaPainel, $Online, $OnlineDesligar) | Where-Object { $_ }
if ($acoes.Count -ne 1) {
    Get-Content -LiteralPath $PSCommandPath -TotalCount 25 | ForEach-Object { Write-Host ($_ -replace '^# ?', '') }
    Write-Host ''
    Write-Host 'Escolha exatamente uma acao.'
    exit 1
}

# Comando bash na pasta do projeto, no servidor.
function Invoke-NaPasta([string]$Bash) {
    $c = Get-VpsConfig
    Invoke-VpsSsh ('cd ' + (ConvertTo-BashArg $c.Pasta) + ' && ' + $Bash)
}

# Devolve $true se o comando (na pasta do projeto) termina com sucesso.
function Test-NaPasta([string]$Bash) {
    Invoke-Externo { Invoke-NaPasta $Bash } -Silencioso
    return ($LASTEXITCODE -eq 0)
}

function Write-Enderecos {
    $p = Get-VpsPortas
    Write-Host "  Painel:  http://localhost:$($p.Painel)"
    Write-Host "  WAHA:    http://localhost:$($p.Waha)/dashboard"
    Write-Host "  n8n:     http://localhost:$($p.N8n)"
    try { $dom = (Read-DotEnv -Servidor)['PAINEL_DOMINIO'] } catch { $dom = $null }
    if ($dom) { Write-Host "  Online:  https://$dom   (painel, com login; nao precisa de tunel)" }
}

# Grava (ou troca) linhas CHAVE=valor no .env do servidor, sem apagar as outras linhas.
# Valores vazios sao permitidos; so letras, numeros e . _ : @ / + = - (nada que o compose interpole).
function Set-EnvVps([System.Collections.IDictionary]$Valores) {
    $filtros = @()
    $linhas = @()
    foreach ($chave in $Valores.Keys) {
        $valor = [string]$Valores[$chave]
        if ($chave -notmatch '^[A-Z][A-Z0-9_]*$') { throw "Nome de variavel invalido: $chave" }
        if ($valor -notmatch '^[A-Za-z0-9._:@/+=-]*$') { throw "Valor invalido para $chave (caracteres nao permitidos)." }
        $filtros += "-e '^$chave='"
        $linhas += "printf '%s\n' '$chave=$valor' >> `"`$tmp`""
    }
    $bash = @(
        'set -e',
        'test -f .env',
        'tmp=$(mktemp .env.tmp.XXXXXX)',
        'chmod 600 "$tmp"',
        ('grep -v ' + ($filtros -join ' ') + ' .env > "$tmp" || true')
    ) + $linhas + @('mv "$tmp" .env')
    Invoke-Externo { Invoke-NaPasta ($bash -join "`n") } -Silencioso
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel gravar no .env do servidor (ele existe? Rode -Enviar antes).' }
    $script:EnvVps = $null
}

# SecureString para texto, so em memoria (a senha nunca vai para argumento de linha de comando nem para log).
function ConvertFrom-SecureStringPlano([System.Security.SecureString]$Segura) {
    $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Segura)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# ---------------------------------------------------------------- configurar
if ($Configurar) {
    if (-not $Servidor) { throw 'Informe o endereco do servidor: vps.ps1 -Configurar -Servidor <ip>' }
    $arquivo = Join-Path $raiz 'deploy\vps.local.json'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $arquivo) | Out-Null
    $json = [ordered]@{ host = $Servidor; usuario = $Usuario; chave = $Chave; pasta = $Pasta } | ConvertTo-Json
    [System.IO.File]::WriteAllText($arquivo, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    $script:VpsConfig = $null
    $null = Get-VpsConfig   # valida os valores e a chave
    Write-Host "Configuracao gravada em $arquivo"
    Write-Host 'Testando a conexao SSH...'
    $saida = Invoke-Externo { Invoke-VpsSsh 'echo conectado; uname -sm' } -Completo
    if ($LASTEXITCODE -ne 0) {
        $saida | ForEach-Object { Write-Host $_ }
        throw 'Nao foi possivel conectar por SSH. Confira o IP, a chave publica colada na VM e se a VM esta ligada.'
    }
    $saida | ForEach-Object { Write-Host $_ }
    Write-Host 'Pronto. Proximo passo: vps.ps1 -Instalar'
    exit 0
}

$null = Get-VpsConfig
$c = Get-VpsConfig

# ---------------------------------------------------------------- instalar
if ($Instalar) {
    $sh = Join-Path $raiz 'deploy\preparar-servidor.sh'
    if (-not (Test-Path -LiteralPath $sh)) { throw "Arquivo nao encontrado: $sh" }
    Write-Host 'Enviando deploy\preparar-servidor.sh...'
    Copy-ParaVps $sh 'preparar-servidor.sh'
    Write-Host 'Preparando o servidor (pode levar alguns minutos)...'
    Invoke-Externo { Invoke-VpsSsh "sed -i 's/\r$//' preparar-servidor.sh; bash preparar-servidor.sh; codigo=`$?; rm -f preparar-servidor.sh; exit `$codigo" } -Completo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'A preparacao do servidor falhou. Veja as mensagens acima (e rode -Instalar de novo: e seguro repetir).' }
    exit 0
}

# ---------------------------------------------------------------- enviar
if ($Enviar) {
    $sujo = @(git -C $raiz status --porcelain --untracked-files=no)
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel consultar o git.' }
    if ($sujo.Count -gt 0) {
        Write-Host 'Ha mudancas nao commitadas. O servidor so recebe o que esta no git (ultimo commit):'
        $sujo | ForEach-Object { Write-Host "  $_" }
        Write-Host 'Faca o commit (ou descarte as mudancas) e rode de novo.'
        exit 1
    }
    $commit = (git -C $raiz rev-parse --short HEAD)
    $pastaB = ConvertTo-BashArg $c.Pasta

    $temConfig = Test-NaPasta 'test -f config/chatbot.json'
    $temEnv = Test-NaPasta 'test -f .env'
    $localEnv = Join-Path $raiz '.env'
    $mandarEnv = ($SobrescreverEnv -or -not $temEnv)
    if ($mandarEnv -and -not (Test-Path -LiteralPath $localEnv)) {
        throw 'O .env nao existe neste computador nem no servidor. Rode primeiro: scripts\gerar-env.ps1'
    }

    $tar = Join-Path ([System.IO.Path]::GetTempPath()) 'chatbot-envio.tar'
    Remove-Item -LiteralPath $tar -Force -ErrorAction SilentlyContinue
    try {
        git -C $raiz archive --format=tar -o $tar HEAD
        if ($LASTEXITCODE -ne 0) { throw 'git archive falhou.' }
        Write-Host "Enviando o commit $commit..."
        Copy-ParaVps $tar 'chatbot-envio.tar'
    } finally { Remove-Item -LiteralPath $tar -Force -ErrorAction SilentlyContinue }

    # config\chatbot.json do servidor e a versao viva (editada pelo painel): so entra na primeira vez.
    $excluir = if ($temConfig) { '--exclude=config/chatbot.json' } else { '' }
    if ($temConfig) { Write-Host 'config\chatbot.json do servidor preservado (nao foi sobrescrito).' }
    else { Write-Host 'Primeira vez: config\chatbot.json vai junto com o codigo.' }
    # --no-overwrite-dir -m: nao mexe em dono/data de pastas que ja existem (a pasta config e gravada pelo painel).
    $bash = "mkdir -p $pastaB && tar -x --no-overwrite-dir -m --no-same-owner $excluir -f chatbot-envio.tar -C $pastaB; rc=`$?; rm -f chatbot-envio.tar; exit `$rc"
    Invoke-Externo { Invoke-VpsSsh $bash } -Completo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao extrair o codigo no servidor.' }

    if ($mandarEnv) {
        # Com -SobrescreverEnv, guarda a configuracao do painel online que ja estava no servidor.
        $configOnline = [ordered]@{}
        if ($temEnv) {
            $atual = Read-DotEnv -Servidor
            foreach ($k in @('PAINEL_DOMINIO', 'PAINEL_USUARIO', 'PAINEL_SENHA_HASH', 'PAINEL_CONFIAR_PROXY', 'COMPOSE_PROFILES')) {
                if ($atual[$k]) { $configOnline[$k] = $atual[$k] }
            }
        }
        Write-Host 'Enviando o .env...'
        Copy-ParaVps $localEnv "$($c.Pasta)/.env.novo"
        Invoke-NaPasta "sed -i 's/\r`$//' .env.novo && chmod 600 .env.novo && mv .env.novo .env"
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao gravar o .env no servidor.' }
        $script:EnvVps = $null
        if ($configOnline.Count -gt 0) {
            Set-EnvVps $configOnline
            Write-Host 'Configuracao do painel online do servidor preservada no novo .env.'
        }
    } else {
        Write-Host '.env do servidor preservado (use -SobrescreverEnv para trocar).'
    }
    $script:EnvVps = $null

    # Prepara o servidor: imagem ARM do WAHA no .env e pasta config gravavel pelo painel (usuario 1000 do conteiner).
    $prep = "if ! grep -q '^WAHA_IMAGEM=' .env; then [ -z `"`$(tail -c1 .env)`" ] || echo >> .env; echo 'WAHA_IMAGEM=$imagemArm' >> .env; echo 'Linha WAHA_IMAGEM=$imagemArm adicionada ao .env do servidor.'; fi; " +
            "chmod 600 .env; sudo -n chown -R 1000:1000 config && chmod 755 config && chmod 644 config/chatbot.json 2>/dev/null; true"
    Invoke-Externo { Invoke-NaPasta $prep } -Completo | Out-Host

    Write-Host 'Subindo os conteineres (a primeira vez baixa as imagens e demora)...'
    Invoke-Externo { Invoke-NaPasta 'docker compose up -d' } -Completo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up -d falhou no servidor.' }
    Invoke-Externo { Invoke-NaPasta 'docker compose ps' } -Completo | Out-Host
    exit 0
}

# ---------------------------------------------------------------- senha do painel
if ($SenhaPainel) {
    $usuarioPainel = Read-Host 'Usuario do painel (Enter = admin)'
    if (-not $usuarioPainel) { $usuarioPainel = 'admin' }
    if ($usuarioPainel -notmatch '^[A-Za-z0-9._-]{3,32}$') { throw 'Usuario invalido: use de 3 a 32 letras, numeros, ponto, hifen ou sublinhado.' }
    $segura1 = Read-Host 'Senha do painel (minimo 12 caracteres)' -AsSecureString
    $segura2 = Read-Host 'Repita a senha' -AsSecureString
    $plana = ConvertFrom-SecureStringPlano $segura1
    $plana2 = ConvertFrom-SecureStringPlano $segura2
    $codigo = 1
    try {
        if ($plana -ne $plana2) { throw 'As duas senhas digitadas sao diferentes.' }
        if ($plana.Length -lt 12) { throw 'A senha precisa ter no minimo 12 caracteres.' }
        Write-Host 'Gerando o hash da senha no servidor...'
        # A senha viaja so pelo stdin do ssh (UTF-8, sem BOM); nunca na linha de comando.
        $cmd = 'docker compose run --rm --no-deps -T --entrypoint node painel /app/painel/senha.js'
        $codificacaoAnterior = $OutputEncoding
        $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        try { $saida = @(Invoke-Externo { $plana | Invoke-VpsSsh ('cd ' + (ConvertTo-BashArg $c.Pasta) + ' && ' + $cmd) }) }
        finally { $OutputEncoding = $codificacaoAnterior }
        $codigo = $LASTEXITCODE
    } finally {
        $plana = $null
        $plana2 = $null
        $segura1.Dispose()
        $segura2.Dispose()
    }
    if ($codigo -ne 0) { throw 'O servidor nao gerou o hash (painel/senha.js falhou). O servidor ja recebeu o codigo novo (-Enviar)?' }
    $hash = (@($saida | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) | Select-Object -Last 1)
    if (-not $hash -or $hash -notmatch '^[A-Za-z0-9._:+/=-]+$') { throw 'O servidor devolveu um hash em formato inesperado. Nada foi gravado.' }
    Set-EnvVps ([ordered]@{ PAINEL_USUARIO = $usuarioPainel; PAINEL_SENHA_HASH = $hash })
    Write-Host 'Usuario e hash gravados no .env do servidor. Reiniciando o painel...'
    Invoke-Externo { Invoke-NaPasta 'docker compose up -d --force-recreate --no-deps painel' } -Completo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel reiniciar o painel no servidor.' }
    Write-Host "Pronto. Usuario do painel: $usuarioPainel. A senha nao fica guardada em nenhum arquivo (so o hash)."
    exit 0
}

# ---------------------------------------------------------------- painel online
if ($Online) {
    if (-not $Dominio) {
        if ($c.Host -match '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') { $Dominio = "$($Matches[1])-$($Matches[2])-$($Matches[3])-$($Matches[4]).sslip.io" }
        else { throw 'Informe o dominio: vps.ps1 -Online -Dominio <dominio>' }
    }
    $Dominio = $Dominio.Trim().ToLowerInvariant()
    if ($Dominio -notmatch '^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$') { throw "Dominio invalido: $Dominio" }

    $envServidor = Read-DotEnv -Servidor
    if (-not $envServidor['PAINEL_SENHA_HASH']) { throw 'O painel ainda nao tem senha. Rode primeiro: vps.ps1 -SenhaPainel (sem senha o painel nao sobe com dominio).' }
    if (-not (Test-NaPasta 'grep -q caddy docker-compose.yml')) { throw 'O servidor ainda nao tem o Caddy no docker-compose.yml. Faca o commit e rode: vps.ps1 -Enviar' }

    $sh = Join-Path $raiz 'deploy\preparar-servidor.sh'
    if (-not (Test-Path -LiteralPath $sh)) { throw "Arquivo nao encontrado: $sh" }
    Write-Host '1/4 Liberando as portas 80 e 443 no firewall do servidor...'
    Copy-ParaVps $sh 'preparar-servidor.sh'
    Invoke-Externo { Invoke-VpsSsh "sed -i 's/\r$//' preparar-servidor.sh; bash preparar-servidor.sh --so-web; codigo=`$?; rm -f preparar-servidor.sh; exit `$codigo" } -Completo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'A etapa de firewall falhou. Veja as mensagens acima (e seguro repetir).' }

    Write-Host '2/4 Gravando a configuracao no .env do servidor...'
    Set-EnvVps ([ordered]@{ PAINEL_DOMINIO = $Dominio; COMPOSE_PROFILES = 'online'; PAINEL_CONFIAR_PROXY = 'true' })

    Write-Host '3/4 Subindo os conteineres (a primeira vez baixa a imagem do Caddy)...'
    Invoke-Externo { Invoke-NaPasta 'docker compose up -d' } -Completo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up -d falhou no servidor.' }

    Write-Host "4/4 Testando https://$Dominio/api/health (o certificado pode levar alguns segundos)..."
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
    $ok = $false
    for ($i = 1; $i -le 24 -and -not $ok; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "https://$Dominio/api/health" -UseBasicParsing -TimeoutSec 10
            if ([int]$r.StatusCode -eq 200) { $ok = $true }
        } catch { Start-Sleep -Seconds 5 }
    }
    if (-not $ok) {
        Write-Host 'O endereco nao respondeu a tempo. Confira:'
        Write-Host '  - Security List da Oracle com as portas 80 e 443 (TCP) liberadas;'
        Write-Host '  - o dominio aponta para o IP do servidor;'
        Write-Host '  - logs: docker compose logs caddy (no servidor), ou vps.ps1 -Status.'
        exit 1
    }
    Write-Host ''
    Write-Host "Painel online: https://$Dominio"
    Write-Host 'Entre com o usuario e a senha definidos em -SenhaPainel.'
    exit 0
}

# ---------------------------------------------------------------- desligar online
if ($OnlineDesligar) {
    Set-EnvVps ([ordered]@{ COMPOSE_PROFILES = ''; PAINEL_CONFIAR_PROXY = 'false' })
    Invoke-Externo { Invoke-NaPasta 'docker compose --profile online rm -sf caddy' } -Completo | Out-Host
    Invoke-Externo { Invoke-NaPasta 'docker compose up -d' } -Completo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up -d falhou no servidor.' }
    Write-Host 'Acesso pela internet desligado (Caddy parado). O painel volta a abrir so pelo tunel: vps.ps1 -Tunel.'
    Write-Host 'PAINEL_DOMINIO e a senha continuam no .env; o painel segue exigindo login.'
    exit 0
}

# ---------------------------------------------------------------- tunel
if ($Tunel) {
    $proc = Open-TunelVps
    if (-not $proc) {
        Write-Host 'Ja existe um tunel aberto para este servidor (em outro terminal). Enderecos:'
        Write-Enderecos
        exit 0
    }
    Write-Host 'Tunel aberto. Enderecos (usuario e senha do WAHA estao no .env do servidor):'
    Write-Enderecos
    Write-Host 'Deixe esta janela aberta. Ctrl+C para fechar o tunel.'
    try {
        while (-not $proc.HasExited) { Start-Sleep -Seconds 2 }
        Write-Host 'O tunel foi encerrado (conexao perdida?). Rode -Tunel de novo.'
        exit 1
    } finally { Stop-TunelVps $proc }
}

# ---------------------------------------------------------------- script
if ($Script) {
    if ($Script -notmatch '^[a-z][a-z0-9-]*$') { throw 'Nome de script invalido.' }
    if (@('testar', 'gerar-env') -contains $Script) { Write-Host "$Script so vale neste computador (nao roda na VPS)."; exit 1 }
    $arquivo = Join-Path $PSScriptRoot "$Script.ps1"
    if (-not (Test-Path -LiteralPath $arquivo)) { throw "Script nao encontrado: scripts\$Script.ps1" }
    $anterior = $env:CHATBOT_VPS
    $tunelProc = $null
    try {
        $env:CHATBOT_VPS = '1'
        if ($Script -eq 'conectar-whatsapp') { $tunelProc = Open-TunelVps }
        # Com "powershell -File" nao ha lista de valores: aceita-se um texto com espacos ou virgulas.
        $lista = @($Argumentos | ForEach-Object { $_ -split '[\s,]+' } | Where-Object { $_ })
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $arquivo @lista
        $codigo = $LASTEXITCODE
    } finally {
        $env:CHATBOT_VPS = $anterior
        Stop-TunelVps $tunelProc
    }
    exit $codigo
}

# ---------------------------------------------------------------- status / parar
if ($Status) {
    Invoke-Externo { Invoke-NaPasta 'docker compose ps; echo; df -h / | tail -n 2; echo; free -h' } -Completo | Out-Host
    exit 0
}

if ($Parar) {
    Invoke-Externo { Invoke-NaPasta 'docker compose down' } -Completo | Out-Host
    exit $LASTEXITCODE
}

# ---------------------------------------------------------------- baixar config
if ($BaixarConfig) {
    $destino = Join-Path $raiz 'config\chatbot.json'
    $novo = "$destino.baixando"
    Copy-DaVps "$($c.Pasta)/config/chatbot.json" $novo
    if (Test-Path -LiteralPath $destino) { Copy-Item -LiteralPath $destino -Destination (Join-Path $raiz 'config\chatbot.json.antes-vps.bak') -Force }
    Move-Item -LiteralPath $novo -Destination $destino -Force
    Write-Host 'config\chatbot.json atualizado com a versao do servidor (a anterior ficou em config\chatbot.json.antes-vps.bak).'
    Write-Host 'Confira com "git diff" e faca o commit.'
    exit 0
}

# ---------------------------------------------------------------- backup
if ($Backup) {
    $destino = Join-Path $raiz ('backups\vps-' + (Get-Date -Format 'yyyy-MM-dd-HHmm'))
    New-Item -ItemType Directory -Force -Path $destino | Out-Null
    Write-Host "Baixando para $destino ..."
    Copy-DaVps "$($c.Pasta)/config/chatbot.json" (Join-Path $destino 'chatbot.json')
    Copy-DaVps "$($c.Pasta)/.env" (Join-Path $destino 'env.txt')
    # Pareamento do WhatsApp: tar do volume, gerado pelo shell do servidor (arquivo do proprio usuario).
    $bash = "docker run --rm -v chatbot-evento_waha_sessions:/dados:ro redis:8-alpine tar czf - -C /dados . > .backup-waha.tar.gz"
    Invoke-Externo { Invoke-NaPasta $bash } -Completo | Out-Host
    if ($LASTEXITCODE -ne 0) { Invoke-Externo { Invoke-NaPasta 'rm -f .backup-waha.tar.gz' } -Silencioso; throw 'Falha ao compactar o volume do WhatsApp no servidor.' }
    Copy-DaVps "$($c.Pasta)/.backup-waha.tar.gz" (Join-Path $destino 'waha_sessions.tar.gz')
    Invoke-Externo { Invoke-NaPasta 'rm -f .backup-waha.tar.gz' } -Silencioso
    Write-Host 'Backup pronto (o .env foi salvo como env.txt). Guarde esta pasta em local seguro: ela tem segredos e o pareamento do WhatsApp.'
    exit 0
}
