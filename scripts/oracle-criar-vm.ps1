# Cria a VM Always Free (Ampere A1) na Oracle tentando de novo ate haver capacidade.
#
# A Oracle costuma responder "Out of capacity" para a VM.Standard.A1.Flex gratuita. Este script
# tenta a cada -Intervalo segundos ate conseguir e no fim mostra o IP publico.
#
#   powershell -ExecutionPolicy Bypass -File scripts\oracle-criar-vm.ps1
#   ... -Ocpus 2 -MemoriaGB 12        maquina maior (o padrao e 1 OCPU e 6 GB; a VM de producao
#                                     foi criada com 2 OCPU e 12 GB, o maximo do Always Free)
#   ... -Intervalo 120                segundos entre tentativas (padrao 90)
#   ... -MaxTentativas 500            desiste depois de N tentativas (padrao 0 = sem limite)
#
# Pre-requisitos (veja docs\vps-oracle.md, secao "Criar a VM automaticamente"):
#   - OCI CLI instalado:            python -m uv tool install --python 3.12 oci-cli
#                                   (pip no Python 3.14 falha ao compilar o PyYAML)
#   - Chave de API em ~\.oci\config (Console > Meu perfil > Chaves de API)
#   - Uma rede com sub-rede PUBLICA, Internet Gateway e rota 0.0.0.0/0 (o Start VCN Wizard
#     pode deixar a rede incompleta: confira; veja docs\solucao-de-problemas.md)
#   - Chave SSH em ~\.ssh\oracle_chatbot.pub
param(
    [int]$Ocpus = 1,
    [int]$MemoriaGB = 6,
    [int]$Intervalo = 90,
    [int]$MaxTentativas = 0,
    [string]$Nome = 'chatbot-evento',
    [string]$ChaveSsh = (Join-Path $env:USERPROFILE '.ssh\oracle_chatbot.pub')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')

# Sem isto o OCI CLI reclama das permissoes do arquivo de chave no Windows a cada chamada.
$env:OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING = 'True'
$Forma = 'VM.Standard.A1.Flex'

# Roda o OCI CLI e devolve o JSON da saida ja convertido (ou $null se nao houver saida).
# Funcao simples (sem param) de proposito: assim "--opcao" chega intacto ao oci.
function Invoke-Oci {
    $ociArgs = $args
    $saida = Invoke-Externo { & oci @ociArgs }
    if ($LASTEXITCODE -ne 0) { throw "O comando 'oci $($ociArgs[0..2] -join ' ')' falhou (codigo $LASTEXITCODE). Rode-o sozinho para ver o erro." }
    $texto = ($saida -join "`n").Trim()
    if (-not $texto) { return $null }
    return $texto | ConvertFrom-Json
}

# --- conferencias ---

# Trava de custo: acima disto a VM sai do Always Free e passa a ser cobrada.
if ($Ocpus -lt 1 -or $Ocpus -gt 2 -or $MemoriaGB -lt 1 -or $MemoriaGB -gt 12) {
    throw 'Fora do Always Free: use no maximo 2 OCPU e 12 GB (o padrao, 1 OCPU e 6 GB, ja basta para o robo).'
}

if (-not (Get-Command oci -ErrorAction SilentlyContinue)) {
    throw 'OCI CLI nao encontrado. Instale com:  python -m pip install oci-cli  (e abra um terminal novo).'
}
$arquivoConfig = Join-Path $env:USERPROFILE '.oci\config'
if (-not (Test-Path -LiteralPath $arquivoConfig)) {
    throw "Arquivo $arquivoConfig nao encontrado. Crie a chave de API (docs\vps-oracle.md, secao 'Criar a VM automaticamente')."
}
if (-not (Test-Path -LiteralPath $ChaveSsh)) { throw "Chave SSH publica nao encontrada: $ChaveSsh" }

$tenancy = (Get-Content -LiteralPath $arquivoConfig | Where-Object { $_ -match '^\s*tenancy\s*=' } | Select-Object -First 1) -replace '^\s*tenancy\s*=\s*', ''
if (-not $tenancy) { throw "Linha 'tenancy=' nao encontrada em $arquivoConfig." }
$tenancy = $tenancy.Trim()

Write-Host 'Conferindo o acesso a Oracle...'
$ads = Invoke-Oci iam availability-domain list --compartment-id $tenancy
$ad = $ads.data[0].name
Write-Host "Dominio de disponibilidade: $ad"

# Ja existe uma VM com este nome? Nao cria outra.
$existentes = Invoke-Oci compute instance list --compartment-id $tenancy --all
$viva = @($existentes.data | Where-Object { $_.'display-name' -eq $Nome -and $_.'lifecycle-state' -notin @('TERMINATED', 'TERMINATING') }) | Select-Object -First 1

function Show-Ip([string]$IdInstancia) {
    $vnics = Invoke-Oci compute instance list-vnics --instance-id $IdInstancia
    $ip = $vnics.data[0].'public-ip'
    Write-Host ''
    if ($ip) {
        Write-Host "IP publico: $ip" -ForegroundColor Green
        Write-Host "Proximo passo: powershell -ExecutionPolicy Bypass -File scripts\vps.ps1 -Configurar -Servidor $ip"
    } else {
        Write-Host 'A VM nao tem IP publico. Atribua um em: Instancia > Networking > VNIC > IP administration > Edit > Ephemeral public IP.' -ForegroundColor Yellow
    }
}

if ($viva) {
    Write-Host "Ja existe a VM '$Nome' (situacao: $($viva.'lifecycle-state')). Nada a criar."
    Show-Ip $viva.id
    exit 0
}

Write-Host 'Procurando a imagem Ubuntu 24.04 para ARM...'
$imagens = Invoke-Oci compute image list --compartment-id $tenancy --operating-system 'Canonical Ubuntu' --operating-system-version '24.04' --shape $Forma --sort-by TIMECREATED --sort-order DESC
$imagem = @($imagens.data) | Select-Object -First 1
if (-not $imagem) { throw 'Imagem Canonical Ubuntu 24.04 para VM.Standard.A1.Flex nao encontrada.' }
Write-Host "Imagem: $($imagem.'display-name')"

Write-Host 'Procurando uma sub-rede publica...'
$subredes = Invoke-Oci network subnet list --compartment-id $tenancy --all
$subrede = @($subredes.data | Where-Object { $_.'prohibit-public-ip-on-vnic' -eq $false -and $_.'lifecycle-state' -eq 'AVAILABLE' }) | Select-Object -First 1
if (-not $subrede) {
    throw 'Nenhuma sub-rede publica encontrada. No console: Networking > Virtual cloud networks > Start VCN Wizard > Create VCN with Internet Connectivity. Depois rode este script de novo.'
}
Write-Host "Sub-rede: $($subrede.'display-name')"

# O PowerShell 5.1 estraga aspas de JSON passadas a programas externos: vai por arquivo.
$arquivoForma = Join-Path $env:TEMP 'oci-forma-chatbot.json'
[System.IO.File]::WriteAllText($arquivoForma, "{`"ocpus`": $Ocpus, `"memoryInGBs`": $MemoriaGB}")

# --- tentativas ---

$capacidade = 'Out of (host )?capacity|InternalError|TooManyRequests|"status": (500|429|503)'
$tentativa = 0
Write-Host ''
Write-Host "Tentando criar a VM ($Ocpus OCPU, $MemoriaGB GB) a cada $Intervalo s. Pode deixar rodando; Ctrl+C para parar."
while ($true) {
    $tentativa++
    $agora = Get-Date -Format 'dd/MM HH:mm:ss'
    $saida = Invoke-Externo {
        & oci compute instance launch --availability-domain $ad --compartment-id $tenancy --shape $Forma `
            --shape-config "file://$arquivoForma" --image-id $imagem.id --subnet-id $subrede.id `
            --assign-public-ip true --display-name $Nome --ssh-authorized-keys-file $ChaveSsh `
            --wait-for-state RUNNING --max-wait-seconds 600
    } -Completo
    $codigo = $LASTEXITCODE
    $texto = ($saida -join "`n")

    if ($codigo -eq 0) {
        Write-Host "[$agora] Tentativa ${tentativa}: VM criada!" -ForegroundColor Green
        Remove-Item -LiteralPath $arquivoForma -ErrorAction SilentlyContinue
        # A saida do launch mistura progresso e JSON: busca a VM nova pelo nome.
        $lista = Invoke-Oci compute instance list --compartment-id $tenancy --all
        $nova = @($lista.data | Where-Object { $_.'display-name' -eq $Nome -and $_.'lifecycle-state' -notin @('TERMINATED', 'TERMINATING') }) | Select-Object -First 1
        Show-Ip $nova.id
        exit 0
    }
    if ($texto -notmatch $capacidade) {
        Write-Host "[$agora] Tentativa ${tentativa}: erro que nao e falta de capacidade. Parando." -ForegroundColor Red
        Write-Host $texto
        exit 1
    }
    Write-Host "[$agora] Tentativa ${tentativa}: sem capacidade. Nova tentativa em $Intervalo s."
    if ($MaxTentativas -gt 0 -and $tentativa -ge $MaxTentativas) {
        Write-Host 'Limite de tentativas atingido.'
        exit 2
    }
    Start-Sleep -Seconds $Intervalo
}
