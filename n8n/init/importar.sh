#!/bin/sh
# Executado pelo serviço "n8n-init" (docker-compose.yml) antes de o n8n subir.
# Na primeira subida importa as credenciais e os workflows e publica (ativa) o chatbot.
# Nas seguintes não altera nada, para preservar o que você editar pela tela do n8n.
#
# Forçar nova importação (com o n8n parado):
#   docker compose stop n8n
#   docker compose run --rm -e IMPORTAR=tudo n8n-init      (ou: credenciais | workflows)
#   docker compose up -d
set -eu

MARCADOR="/home/node/.n8n/.chatbot-evento-importado"
MODO="${IMPORTAR:-auto}"
ID_PRINCIPAL="ChatbotEvento001"
ID_ERROS="ChatbotEventoErr"

log() { echo "[n8n-init] $*"; }

# Retenção: apaga arquivos de log mais antigos que LOG_RETENCAO_DIAS.
DIAS="${LOG_RETENCAO_DIAS:-30}"
if [ -d /files/logs ]; then
  find /files/logs -maxdepth 1 -type f -name '*.log' -mtime +"$DIAS" -delete 2>/dev/null || true
  # Conversas (com o texto das mensagens) têm retenção curta: CONVERSAS_RETENCAO_DIAS (1 a 30,
  # padrão 7). O painel também apaga esses arquivos a cada hora, pela data no nome.
  DIAS_CONVERSAS="${CONVERSAS_RETENCAO_DIAS:-7}"
  case "$DIAS_CONVERSAS" in ''|*[!0-9]*) DIAS_CONVERSAS=7 ;; esac
  [ "$DIAS_CONVERSAS" -lt 1 ] && DIAS_CONVERSAS=1
  [ "$DIAS_CONVERSAS" -gt 30 ] && DIAS_CONVERSAS=30
  find /files/logs -maxdepth 1 -type f -name 'conversas-*.log' -mtime +"$((DIAS_CONVERSAS - 1))" -delete 2>/dev/null || true
fi

if [ "$MODO" = "auto" ]; then
  if [ -f "$MARCADOR" ]; then
    log "Credenciais e workflows já importados. Nada a fazer."
    exit 0
  fi
  MODO="tudo"
fi

case "$MODO" in
  tudo|credenciais|workflows) ;;
  *) log "Valor inválido em IMPORTAR: '$MODO' (use auto, tudo, credenciais ou workflows)."; exit 2 ;;
esac

if [ "$MODO" = "tudo" ] || [ "$MODO" = "credenciais" ]; then
  : "${WAHA_API_KEY:?WAHA_API_KEY ausente}"
  : "${WEBHOOK_TOKEN:?WEBHOOK_TOKEN ausente}"
  : "${REDIS_PASSWORD:?REDIS_PASSWORD ausente}"
  umask 077
  TEMPORARIO="/tmp/credenciais-$$.json"
  trap 'rm -f "$TEMPORARIO"' EXIT
  node /init/gerar-credenciais.js > "$TEMPORARIO"
  log "Importando credenciais (os valores não são exibidos)..."
  n8n import:credentials --input="$TEMPORARIO"
  rm -f "$TEMPORARIO"
fi

if [ "$MODO" = "tudo" ] || [ "$MODO" = "workflows" ]; then
  log "Importando workflows..."
  n8n import:workflow --input=/workflows/chatbot-evento-erros.json
  n8n import:workflow --input=/workflows/chatbot-evento.json
  log "Publicando (ativando) o chatbot..."
  n8n publish:workflow --id="$ID_ERROS" || log "Aviso: não foi possível publicar o workflow de erros."
  n8n publish:workflow --id="$ID_PRINCIPAL"
fi

date > "$MARCADOR"
log "Concluído."
