#!/usr/bin/env bash
# Prepara uma VM Ubuntu 24.04 (aarch64, Oracle Cloud) para rodar o chatbot com Docker Compose.
#
# Uso (no servidor):  bash preparar-servidor.sh [usuario]
#   usuario: quem vai usar o Docker (padrao: quem chamou o script, ou SUDO_USER).
#
# Pode ser executado varias vezes sem estragar nada (idempotente).
# NAO mexe em firewall (iptables/ufw/Security List da Oracle): isso fica por conta do operador.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# Usa sudo apenas quando nao somos root (ex.: teste dentro de um conteiner).
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

# Executa um comando como root, com sudo quando necessario.
como_root() {
  if [ -n "$SUDO" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

# Mostra um aviso sem abortar o script.
aviso() {
  echo "    AVISO: $*" >&2
}

ALVO="${1:-${SUDO_USER:-$(id -un)}}"

if ! id "$ALVO" >/dev/null 2>&1; then
  echo "ERRO: usuario '$ALVO' nao existe." >&2
  exit 1
fi

echo "Preparando o servidor para o usuario '$ALVO'."

# ---------------------------------------------------------------------------
echo "==> 1/9 Configurando fuso horario para America/Sao_Paulo..."
if ! como_root timedatectl set-timezone America/Sao_Paulo; then
  aviso "nao foi possivel definir o fuso horario (timedatectl falhou). Continuando."
fi

# ---------------------------------------------------------------------------
echo "==> 2/9 Atualizando lista de pacotes e instalando utilitarios basicos..."
como_root apt-get update -qq
como_root apt-get install -y -qq ca-certificates curl gnupg

# ---------------------------------------------------------------------------
echo "==> 3/9 Instalando Docker Engine e plugin compose (repositorio oficial)..."
if docker compose version >/dev/null 2>&1; then
  echo "    Docker Compose ja esta instalado; pulando a instalacao."
else
  como_root install -m 0755 -d /etc/apt/keyrings
  como_root curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  como_root chmod a+r /etc/apt/keyrings/docker.asc

  ARQUITETURA="$(dpkg --print-architecture)"
  CODENOME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=${ARQUITETURA} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENOME} stable" \
    | como_root tee /etc/apt/sources.list.d/docker.list >/dev/null

  como_root apt-get update -qq
  como_root apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# ---------------------------------------------------------------------------
echo "==> 4/9 Adicionando '$ALVO' ao grupo docker..."
GRUPOS=" $(id -nG "$ALVO") "
if [[ "$GRUPOS" == *" docker "* ]]; then
  echo "    '$ALVO' ja esta no grupo docker."
else
  como_root usermod -aG docker "$ALVO"
  echo "    '$ALVO' adicionado ao grupo docker."
  echo "    IMPORTANTE: reconecte a sessao SSH para a permissao do grupo valer."
fi

# ---------------------------------------------------------------------------
echo "==> 5/9 Ligando o Docker no boot..."
if ! como_root systemctl enable --now docker; then
  aviso "nao foi possivel ativar o servico docker (systemd inativo? ambiente sem systemd). Continuando."
fi

# ---------------------------------------------------------------------------
echo "==> 6/9 Garantindo atualizacoes automaticas (unattended-upgrades)..."
como_root apt-get install -y -qq unattended-upgrades
como_root tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
if ! como_root systemctl enable --now unattended-upgrades; then
  aviso "nao foi possivel ativar o servico unattended-upgrades (systemd inativo?). Continuando."
fi

# ---------------------------------------------------------------------------
echo "==> 7/9 Configurando swap de 2 GB..."
SWAP_FILE=/swapfile
if [ -n "$(swapon --show 2>/dev/null || true)" ]; then
  echo "    Ja existe swap ativo; nada a fazer."
else
  if [ ! -e "$SWAP_FILE" ]; then
    echo "    Criando $SWAP_FILE de 2 GB..."
    if ! como_root fallocate -l 2G "$SWAP_FILE" 2>/dev/null; then
      como_root dd if=/dev/zero of="$SWAP_FILE" bs=1M count=2048 status=none
    fi
    como_root chmod 600 "$SWAP_FILE"
    como_root mkswap "$SWAP_FILE" >/dev/null
  fi
  if como_root swapon "$SWAP_FILE"; then
    if ! grep -qs '^/swapfile[[:space:]]' /etc/fstab; then
      echo "/swapfile none swap sw 0 0" | como_root tee -a /etc/fstab >/dev/null
    fi
    echo "    Swap ativado."
  else
    aviso "nao foi possivel ativar o swap (ambiente sem privilegio?). Continuando."
  fi
fi

# ---------------------------------------------------------------------------
# 8/9 - Firewall: este script NAO altera iptables, ufw nem a Security List da Oracle.
#       Libere as portas necessarias (ex.: 80/443) manualmente, se precisar.

# ---------------------------------------------------------------------------
echo "==> 9/9 Resumo final"
echo "--- Versoes ---"
docker --version || aviso "docker nao encontrado."
docker compose version || aviso "docker compose nao encontrado."
echo "--- Fuso horario ---"
timedatectl 2>/dev/null | grep 'Time zone' || aviso "nao foi possivel ler o fuso horario."
echo "--- Memoria e swap ---"
free -h || aviso "nao foi possivel mostrar memoria (comando free ausente)."

echo ""
echo "Preparacao concluida."
echo "Proximos passos:"
echo "  1. Saia e entre de novo no SSH para o grupo docker valer para '$ALVO'."
echo "  2. No seu PC, rode: scripts\\vps.ps1 -Enviar"
