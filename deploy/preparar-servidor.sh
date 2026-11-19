#!/usr/bin/env bash
# Prepara uma VM Ubuntu 24.04 (aarch64, Oracle Cloud) para rodar o chatbot com Docker Compose.
#
# Uso (no servidor):  bash preparar-servidor.sh [usuario] [--abrir-web] [--so-web]
#   usuario:      quem vai usar o Docker (padrao: quem chamou o script, ou SUDO_USER).
#   --abrir-web:  etapa 8 opcional: libera as portas 80 e 443 no iptables (painel online com HTTPS).
#   --so-web:     roda SOMENTE a etapa 8 (implica --abrir-web). Usado por "vps.ps1 -Online".
#
# Pode ser executado varias vezes sem estragar nada (idempotente).
# Sem --abrir-web o script NAO mexe em firewall. A Security List da Oracle (rede da nuvem) nunca
# e alterada por aqui: portas 80 e 443 tambem precisam ser liberadas la, pelo console ou OCI CLI.
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

# Etapa 8 (opcional): libera 80/tcp, 443/tcp e 443/udp (HTTP/3) no iptables do Ubuntu da Oracle.
#
# As imagens Ubuntu da Oracle trazem em /etc/iptables/rules.v4 uma regra "-A INPUT -j REJECT" no
# fim da cadeia INPUT, que barra tudo o que nao for SSH. Por isso as regras ACCEPT entram ANTES
# dela (iptables -C antes de -I: sem duplicar). Portas publicadas pelo Docker passam por DNAT na
# tabela nat e pela cadeia FORWARD, nao pela INPUT; entao o ACCEPT na INPUT pode nao ser
# estritamente necessario para elas, mas deixa a abertura explicita e funciona mesmo que o
# Docker mude de comportamento. A cadeia FORWARD da Oracle tambem termina em REJECT, mas o Docker
# insere as proprias regras (DOCKER-USER, DOCKER-FORWARD) NO TOPO dela, antes do REJECT: nada a
# fazer; so conferimos e avisamos se for diferente.
#
# Persistencia: em vez de "netfilter-persistent save" (que gravaria tambem as cadeias efemeras do
# Docker em rules.v4), as linhas sao inseridas direto em /etc/iptables/rules.v4. Se o arquivo
# nao tiver o formato esperado, usa "netfilter-persistent save" como alternativa.
abrir_web() {
  if ! command -v iptables >/dev/null 2>&1; then
    aviso "iptables nao encontrado; nada a liberar."
    return 0
  fi

  if ! dpkg -s iptables-persistent >/dev/null 2>&1; then
    echo "    Instalando iptables-persistent (mantem as regras apos reiniciar)..."
    como_root apt-get update -qq
    como_root apt-get install -y -qq iptables-persistent
  fi

  # "proto porta": regra ACCEPT inserida antes do primeiro REJECT da INPUT (ou no fim, se nao houver).
  local regra proto porta posicao
  for regra in "tcp 80" "tcp 443" "udp 443"; do
    proto="${regra% *}"
    porta="${regra#* }"
    if como_root iptables -C INPUT -p "$proto" --dport "$porta" -j ACCEPT 2>/dev/null; then
      echo "    Regra $proto/$porta ja existe."
      continue
    fi
    posicao="$(como_root iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
    if [ -n "$posicao" ]; then
      como_root iptables -I INPUT "$posicao" -p "$proto" --dport "$porta" -j ACCEPT
    else
      como_root iptables -A INPUT -p "$proto" --dport "$porta" -j ACCEPT
    fi
    echo "    Liberado $proto/$porta."
  done

  # Persistencia em /etc/iptables/rules.v4.
  local arq=/etc/iptables/rules.v4 linha tmp persistiu=1
  if como_root test -f "$arq" && como_root grep -q '^-A INPUT .*-j REJECT' "$arq"; then
    for linha in "-A INPUT -p tcp -m tcp --dport 80 -j ACCEPT"                  "-A INPUT -p tcp -m tcp --dport 443 -j ACCEPT"                  "-A INPUT -p udp -m udp --dport 443 -j ACCEPT"; do
      if como_root grep -qxF -- "$linha" "$arq"; then
        continue
      fi
      tmp="$(mktemp)"
      como_root cat "$arq" | awk -v l="$linha" '!feito && /^-A INPUT .*-j REJECT/ { print l; feito = 1 } { print }' > "$tmp"
      # tee preserva dono e permissoes do arquivo original.
      como_root tee "$arq" >/dev/null < "$tmp"
      rm -f "$tmp"
    done
    echo "    Regras gravadas em $arq (valem apos reiniciar)."
    persistiu=0
  fi
  if [ "$persistiu" -ne 0 ]; then
    if como_root netfilter-persistent save >/dev/null 2>&1; then
      echo "    Regras gravadas com netfilter-persistent save."
    else
      aviso "nao foi possivel gravar as regras para depois do reinicio. Rode: sudo netfilter-persistent save"
    fi
  fi

  # Confere a cadeia FORWARD: o REJECT da Oracle nao pode vir antes das regras do Docker.
  local rej dock
  rej="$(como_root iptables -S FORWARD | awk '/-j REJECT/ { print NR; exit }')"
  dock="$(como_root iptables -S FORWARD | awk '/-j DOCKER/ { print NR; exit }')"
  if [ -n "$rej" ] && { [ -z "$dock" ] || [ "$dock" -gt "$rej" ]; }; then
    aviso "a cadeia FORWARD tem um REJECT antes das regras do Docker; as portas publicadas podem ficar bloqueadas. Reinicie o Docker (sudo systemctl restart docker) e confira com: sudo iptables -S FORWARD"
  fi

  # Ubuntu com ufw ativo (nao e o padrao da Oracle): libera tambem por la.
  if command -v ufw >/dev/null 2>&1 && como_root ufw status 2>/dev/null | grep -q '^Status: active'; then
    como_root ufw allow 80/tcp >/dev/null
    como_root ufw allow 443/tcp >/dev/null
    como_root ufw allow 443/udp >/dev/null
    echo "    ufw: 80 e 443 liberadas."
  fi

  echo "    Lembrete: a Security List da Oracle tambem precisa liberar 80 e 443 (TCP) e 443 (UDP)."
}

# Argumentos: [usuario] [--abrir-web] [--so-web], em qualquer ordem.
ABRIR_WEB=0
SO_WEB=0
USUARIO_ARG=""
for argumento in "$@"; do
  case "$argumento" in
    --abrir-web) ABRIR_WEB=1 ;;
    --so-web) ABRIR_WEB=1; SO_WEB=1 ;;
    -*) echo "ERRO: opcao desconhecida '$argumento'." >&2; exit 1 ;;
    *) USUARIO_ARG="$argumento" ;;
  esac
done

if [ "$SO_WEB" -eq 1 ]; then
  echo "==> 8/9 Liberando as portas 80 e 443 no firewall (iptables)..."
  abrir_web
  exit 0
fi

ALVO="${USUARIO_ARG:-${SUDO_USER:-$(id -un)}}"

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
echo "==> 8/9 Firewall (portas 80 e 443 para o painel online)..."
if [ "$ABRIR_WEB" -eq 1 ]; then
  abrir_web
else
  echo "    Nao alterado (use --abrir-web para liberar 80 e 443 no iptables)."
fi

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
