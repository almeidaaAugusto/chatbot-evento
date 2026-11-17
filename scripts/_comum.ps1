# Funcoes compartilhadas pelos scripts desta pasta. Nao execute este arquivo diretamente.
#
# Os arquivos .ps1 deste projeto nao usam acentos de proposito: o Windows PowerShell 5.1
# le arquivos sem BOM como ANSI e trocaria os caracteres acentuados.

$script:Raiz = Split-Path -Parent $PSScriptRoot

# Os conteineres escrevem em UTF-8; sem isto os acentos aparecem trocados no terminal.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Get-Raiz { return $script:Raiz }

# Le o arquivo .env da raiz do projeto e devolve uma tabela NOME -> valor.
function Read-DotEnv {
    $caminho = Join-Path $script:Raiz '.env'
    if (-not (Test-Path -LiteralPath $caminho)) {
        throw 'Arquivo .env nao encontrado. Rode primeiro: powershell -ExecutionPolicy Bypass -File scripts\gerar-env.ps1'
    }
    $valores = @{}
    foreach ($linha in Get-Content -LiteralPath $caminho -Encoding UTF8) {
        if ($linha -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $valores[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
        }
    }
    return $valores
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
