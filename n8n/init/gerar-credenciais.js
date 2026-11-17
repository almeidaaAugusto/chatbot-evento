// Monta, a partir das variáveis de ambiente, o JSON de credenciais que o n8n importa.
// A saída vai para um arquivo temporário dentro do contêiner, apagado logo após a importação.

const obrigatoria = (nome) => {
  const valor = process.env[nome];
  if (!valor) {
    console.error('Variável de ambiente ausente: ' + nome);
    process.exit(1);
  }
  return valor;
};

const credenciais = [
  {
    id: 'ChatbotWahaApi01',
    name: 'WAHA - chave da API',
    type: 'httpHeaderAuth',
    data: { name: 'X-Api-Key', value: obrigatoria('WAHA_API_KEY') },
  },
  {
    id: 'ChatbotWebhook01',
    name: 'Webhook - token do WAHA',
    type: 'httpHeaderAuth',
    data: { name: 'X-Webhook-Token', value: obrigatoria('WEBHOOK_TOKEN') },
  },
  {
    id: 'ChatbotRedis0001',
    name: 'Redis - estado do chatbot',
    type: 'redis',
    data: {
      host: process.env.REDIS_HOST || 'redis',
      port: 6379,
      database: 0,
      password: obrigatoria('REDIS_PASSWORD'),
      ssl: false,
    },
  },
  {
    // Opcional: sem chave a credencial existe (o workflow a referencia), mas a IA só é
    // consultada quando "ia.ativa" está ligada em config/chatbot.json.
    id: 'ChatbotIaApi0001',
    name: 'IA - chave da API',
    type: 'httpHeaderAuth',
    data: { name: 'Authorization', value: 'Bearer ' + (String(process.env.IA_API_KEY || '').trim() || 'chave-nao-configurada') },
  },
];

process.stdout.write(JSON.stringify(credenciais));
