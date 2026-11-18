# Mostra o registro de atividade do chatbot (sem telefones completos e sem o texto das mensagens).
# Para ver o texto das conversas e as respostas, use a pagina http://localhost:8080/conversas.
#
#   powershell -ExecutionPolicy Bypass -File scripts\ver-logs.ps1
#       Ultimos 30 eventos tratados pelo robo.
#   ... -Linhas 100    Quantidade de linhas.
#   ... -Erros         Mostra o registro de erros em vez do registro de atividade.
#   ... -Exportar      Copia todos os arquivos de log para a pasta logs\ do projeto.
#
# Os logs ficam em um volume do Docker (e nao direto na pasta do projeto) para que
# varias mensagens simultaneas possam ser registradas sem perder linhas.
param([int]$Linhas = 30, [switch]$Erros, [switch]$Exportar)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_comum.ps1')
Assert-Docker
Set-Location (Get-Raiz)

if ($Exportar) {
    $destino = Join-Path (Get-Raiz) 'logs'
    New-Item -ItemType Directory -Force -Path $destino | Out-Null
    if ($script:ModoVps) {
        # Copia dentro do servidor e baixa os arquivos .log para a pasta logs\ deste computador.
        $c = Get-VpsConfig
        $tmp = '.logs-exportados'
        Invoke-Externo { Invoke-VpsSsh ('cd ' + (ConvertTo-BashArg $c.Pasta) + ' && rm -rf ' + $tmp + ' && mkdir ' + $tmp) } -Silencioso
        Invoke-Externo { docker compose cp n8n:/files/logs/. $tmp } -Silencioso
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel copiar os logs. O n8n esta no ar? Rode: docker compose up -d' }
        $nomes = @(Invoke-Externo { Invoke-VpsSsh ('cd ' + (ConvertTo-BashArg $c.Pasta) + '/' + $tmp + ' && ls -1 *.log 2>/dev/null; true') } | Where-Object { $_ -match '^[A-Za-z0-9._-]+\.log$' })
        foreach ($nome in $nomes) { Copy-DaVps ($c.Pasta + '/' + $tmp + '/' + $nome) (Join-Path $destino $nome) }
        Invoke-Externo { Invoke-VpsSsh ('cd ' + (ConvertTo-BashArg $c.Pasta) + ' && rm -rf ' + $tmp) } -Silencioso
    } else {
        Invoke-Externo { docker compose cp n8n:/files/logs/. $destino } -Silencioso
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel copiar os logs. O n8n esta no ar? Rode: docker compose up -d' }
    }
    $quantidade = @(Get-ChildItem -LiteralPath $destino -Filter '*.log' -File).Count
    Write-Host "$quantidade arquivo(s) de log em $destino"
    exit 0
}

$prefixo = if ($Erros) { 'erros' } else { 'chatbot' }
# O laco "for" (em vez de um "cat" direto) e o "< /dev/null" evitam que o comando fique
# esperando digitacao quando ainda nao existe nenhum arquivo de log.
$comando = "for f in `$(ls /files/logs/$prefixo-*.log 2>/dev/null | tail -n 3); do cat `$f; done < /dev/null | tail -n $Linhas"
$bruto = Invoke-Externo { docker compose exec -T n8n sh -c $comando }
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel ler os logs. O n8n esta no ar? Rode: docker compose up -d' }

$registros = @($bruto | Where-Object { $_ -and $_.Trim() } | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_ })
if ($registros.Count -eq 0) {
    if ($Erros) { Write-Host 'Nenhum erro registrado.' } else { Write-Host 'Nenhuma atividade registrada ainda.' }
    exit 0
}

if ($Erros) {
    $registros | ForEach-Object {
        [pscustomobject]@{ Quando = ([string]$_.quando).Substring(0, 19).Replace('T', ' '); No = $_.no; HTTP = $_.http; Erro = $_.erro; Detalhe = $_.descricao }
    } | Format-List
} else {
    $registros | ForEach-Object {
        [pscustomobject]@{
            Quando    = ([string]$_.quando).Substring(0, 19).Replace('T', ' ')
            Resultado = $_.resultado
            Motivo    = $_.motivo
            Intencao  = $_.intencao
            IA        = $_.ia
            Contato   = $_.contato
            Detalhe   = $_.detalhe
        }
    } | Format-Table -AutoSize
}
