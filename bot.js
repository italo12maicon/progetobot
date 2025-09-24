const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const SESSION_DIR = './session';
const CONFIG_FILE = './config.json';

// Carregar ou inicializar configuracoes
let config = {
  welcome: { enabled: false, message: '', media: '', private: { enabled: false, message: '', media: '' } },
  goodbye: { enabled: false, message: '', media: '' },
  antilink: { enabled: false, ban: false },
  antiwords: { enabled: false, words: [], ban: false },
  chatbot: { enabled: false, triggers: {}, media: {} }
};
if (fs.existsSync(CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE));
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'Admim-Bot', dataPath: SESSION_DIR }),
  puppeteer: { headless: true }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', () => console.log('Admim-Bot está pronto!'));

// Funções auxiliares
async function isGroupAdmin(chat, userId) {
  try {
    if (!chat.isGroup) return false;
    const participant = chat.participants.find(p => p.id._serialized === userId);
    return participant?.isAdmin || false;
  } catch {
    return false;
  }
}

async function extractContacts(chat) {
  if (!chat.isGroup) return [];
  const contacts = [];
  for (const p of chat.participants) {
    const contact = await client.getContactById(p.id._serialized);
    contacts.push({
      Nome: contact.pushname || contact.name || 'Sem nome',
      Número: p.id.user,
      Admin: p.isAdmin ? 'Sim' : 'Não'
    });
  }
  return contacts;
}

async function sendExcel(msg, contacts) {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Contatos');
  ws.columns = [
    { header: 'Nome', key: 'Nome', width: 30 },
    { header: 'Número', key: 'Número', width: 20 },
    { header: 'Admin', key: 'Admin', width: 10 }
  ];
  contacts.forEach(c => ws.addRow(c));
  const filePath = path.join(__dirname, 'Contatos.xlsx');
  await workbook.xlsx.writeFile(filePath);
  await client.sendMessage(msg.from, MessageMedia.fromFilePath(filePath), { caption: 'Lista de contatos extraída.' });
  fs.unlinkSync(filePath);
}

// Eventos - boas-vindas e despedidas em grupos
client.on('group_participants_changed', async notification => {
  try {
    const chat = await notification.getChat();
    if (notification.action === 'add' && config.welcome.enabled) {
      if (config.welcome.media && fs.existsSync(config.welcome.media)) {
        await chat.sendMessage(MessageMedia.fromFilePath(config.welcome.media));
      }
      if (config.welcome.message) {
        await chat.sendMessage(config.welcome.message);
      }
    }
    if (notification.action === 'remove' && config.goodbye.enabled) {
      if (config.goodbye.media && fs.existsSync(config.goodbye.media)) {
        await chat.sendMessage(MessageMedia.fromFilePath(config.goodbye.media));
      }
      if (config.goodbye.message) {
        await chat.sendMessage(config.goodbye.message);
      }
    }
  } catch { /* ignore erros */ }
});

// Mensagens recebidas - comandos
client.on('message_create', async msg => {
  if (!msg.body.startsWith('!')) return;

  const chat = await msg.getChat();
  const userId = msg.author || msg.from;
  const [rawCmd, ...args] = msg.body.slice(1).split(' ');
  const command = rawCmd.toLowerCase();

  // Função para checar admin no grupo
  async function requireAdmin() {
    const admin = await isGroupAdmin(chat, userId);
    if (!admin) {
      msg.reply('❌ Você precisa ser admin do grupo para usar este comando.');
      return false;
    }
    return true;
  }

  // Comandos gerais
  if (command === 'help') {
    return msg.reply(`Comandos disponíveis:
!help - Lista comandos
!ping - Testar bot
!info - Info grupo
!extracto cont - Extrai contatos em Excel para você

Boas-vindas:
!welcome on/off | set <msg> | media <caminho>
!welcomepv on/off | set <msg> | media <caminho>
!goodbye on/off | set <msg> | media <caminho>

Moderação:
!antilink on/off | ban on/off
!antiwords on/off | add <palavra> | remove <palavra> | ban on/off | list
!ban <@user>
!removeall

Administração:
!promote @user | !demote @user
!add <números separados por ,>
!fixa (responda mensagem)
!tagall <msg> | !tagallcut <msg>
!rename <nome> | !desc <desc>
!creatgrup <nome>

Chatbot:
!chatbot on/off
!chatbot add <gatilho>=<resposta> (um por linha)
!chatbot media <gatilho> <caminho>
!chatbot remove <gatilho>
!chatbot list

!mensege post on/off
!mensege post minutos <minutos> <mensagem> [<midia>]

!poll <pergunta>=<op1>=<op2>
!poll resulte
`);
  }

  if (command === 'ping') return msg.reply('Pong!');
  if (command === 'info' && chat.isGroup) return msg.reply(`Grupo: ${chat.name}\nMembros: ${chat.participants.length}`);

  // Extração contatos
  if (command === 'extracto' && args[0] === 'cont' && chat.isGroup) {
    const contacts = await extractContacts(chat);
    await sendExcel(msg, contacts);
    return;
  }

  // Welcome
  if (command === 'welcome') {
    if (!await requireAdmin()) return;
    const sub = args[0];
    switch (sub) {
      case 'on': config.welcome.enabled = true; saveConfig(); return msg.reply('Boas-vindas ativadas.');
      case 'off': config.welcome.enabled = false; saveConfig(); return msg.reply('Boas-vindas desativadas.');
      case 'set': config.welcome.message = args.slice(1).join(' '); saveConfig(); return msg.reply('Mensagem de boas-vindas definida.');
      case 'media': config.welcome.media = args.slice(1).join(' '); saveConfig(); return msg.reply('Mídia de boas-vindas definida.');
      default: return msg.reply('Use !welcome on/off | set <mensagem> | media <caminho>');
    }
  }

  // Welcomepv
  if (command === 'welcomepv') {
    if (!await requireAdmin()) return;
    const sub = args[0];
    switch (sub) {
      case 'on': config.welcome.private.enabled = true; saveConfig(); return msg.reply('Boas-vindas privadas ativadas.');
      case 'off': config.welcome.private.enabled = false; saveConfig(); return msg.reply('Boas-vindas privadas desativadas.');
      case 'set': config.welcome.private.message = args.slice(1).join(' '); saveConfig(); return msg.reply('Mensagem privada definida.');
      case 'media': config.welcome.private.media = args.slice(1).join(' '); saveConfig(); return msg.reply('Mídia privada definida.');
      default: return msg.reply('Use !welcomepv on/off | set <mensagem> | media <caminho>');
    }
  }

  // Goodbye
  if (command === 'goodbye') {
    if (!await requireAdmin()) return;
    const sub = args[0];
    switch (sub) {
      case 'on': config.goodbye.enabled = true; saveConfig(); return msg.reply('Despedidas ativadas.');
      case 'off': config.goodbye.enabled = false; saveConfig(); return msg.reply('Despedidas desativadas.');
      case 'set': config.goodbye.message = args.slice(1).join(' '); saveConfig(); return msg.reply('Mensagem de despedida definida.');
      case 'media': config.goodbye.media = args.slice(1).join(' '); saveConfig(); return msg.reply('Mídia de despedida definida.');
      default: return msg.reply('Use !goodbye on/off | set <mensagem> | media <caminho>');
    }
  }

  // Moderação: Antilink
  if (command === 'antilink') {
    if (!await requireAdmin()) return;
    if (args[0] === 'on') { config.antilink.enabled = true; saveConfig(); return msg.reply('Antilink ativado.'); }
    if (args[0] === 'off') { config.antilink.enabled = false; saveConfig(); return msg.reply('Antilink desativado.'); }
    if (args[0] === 'ban' && args[1] === 'on') { config.antilink.ban = true; saveConfig(); return msg.reply('Ban por link ativado.'); }
    if (args[0] === 'ban' && args[1] === 'off') { config.antilink.ban = false; saveConfig(); return msg.reply('Ban por link desativado.'); }
    return msg.reply('Use: !antilink on/off | ban on/off');
  }

  // Antiwords
  if (command === 'antiwords') {
    if (!await requireAdmin()) return;
    switch (args[0]) {
      case 'on': config.antiwords.enabled = true; saveConfig(); return msg.reply('Anti-palavrões ativado.');
      case 'off': config.antiwords.enabled = false; saveConfig(); return msg.reply('Anti-palavrões desativado.');
      case 'ban':
        if (args[1] === 'on') { config.antiwords.ban = true; saveConfig(); return msg.reply('Ban por palavrões ativado.'); }
        if (args[1] === 'off') { config.antiwords.ban = false; saveConfig(); return msg.reply('Ban por palavrões desativado.'); }
        break;
      case 'add':
        if (!args[1]) return msg.reply('Faltou informar palavra a adicionar.');
        const newWord = args[1].toLowerCase();
        if (!config.antiwords.words.includes(newWord)) {
          config.antiwords.words.push(newWord);
          saveConfig();
          return msg.reply(`Palavra "${newWord}" adicionada.`);
        } else return msg.reply('Palavra já existe na lista.');
      case 'remove':
        if (!args[1]) return msg.reply('Faltou informar palavra a remover.');
        config.antiwords.words = config.antiwords.words.filter(w => w !== args[1].toLowerCase());
        saveConfig();
        return msg.reply(`Palavra "${args[1]}" removida.`);
      case 'list':
        if (config.antiwords.words.length === 0) return msg.reply('Lista vazia.');
        return msg.reply('Lista de palavras: ' + config.antiwords.words.join(', '));
      default:
        return msg.reply('Use: !antiwords on/off | add <palavra> | remove <palavra> | ban on/off | list');
    }
  }

  // Banir usuários marcados
  if (command === 'ban') {
    if (!await requireAdmin()) return;
    if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('Marque usuário(s) para banir.');
    try {
      const chatGroup = await msg.getChat();
      await chatGroup.removeParticipants(msg.mentionedIds);
      return msg.reply('Usuário(s) banido(s).');
    } catch {
      return msg.reply('Falha ao banir usuário(s).');
    }
  }

  // Remove all (não admins)
  if (command === 'removeall') {
    if (!await requireAdmin()) return;
    if (!chat.isGroup) return msg.reply('Comando válido apenas para grupos.');
    for (const p of chat.participants) {
      if (!p.isAdmin) {
        try { await chat.removeParticipants([p.id._serialized]); } catch {}
      }
    }
    return msg.reply('Todos os não-admins removidos.');
  }

  // Administração - promover/demote
  if (command === 'promote' || command === 'demote') {
    if (!await requireAdmin()) return;
    if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('Marque usuário(s).');
    const chatGroup = await msg.getChat();
    for (const userId of msg.mentionedIds) {
      try {
        if (command === 'promote') await chatGroup.promoteParticipant(userId);
        else await chatGroup.demoteParticipant(userId);
      } catch {}
    }
    return msg.reply(`Usuário(s) ${command}dado(s).`);
  }

  // Adicionar membros pelo número
  if (command === 'add') {
    if (!await requireAdmin()) return;
    if (args.length === 0) return msg.reply('Informe os números separados por vírgula.');
    const nums = args.join('').split(',');
    for (const num of nums) {
      try {
        await client.addParticipant(chat.id._serialized, num.trim() + '@c.us');
      } catch {}
    }
    return msg.reply('Solicitações de adição enviadas.');
  }

  // Fixa (responda a mensagem)
  if (command === 'fixa') {
    if (!await requireAdmin()) return;
    if (!msg.hasQuotedMsg) return msg.reply('Responda a mensagem para fixar.');
    const quoted = await msg.getQuotedMessage();
    // API do whatsapp-web.js não suporta fixar mensagem, então apenas reenviamos
    await chat.sendMessage(quoted.body);
    return msg.reply('Fixar mensagem não suportado via API. Mensagem reenviada.');
  }

  // Tagall e tagallcut
  if (command === 'tagall' || command === 'tagallcut') {
    if (!await requireAdmin()) return;
    if (!chat.isGroup) return msg.reply('Comando válido apenas em grupos.');
    const text = args.join(' ');
    const mentions = chat.participants.map(p => p.id._serialized);
    if (command === 'tagall') {
      await chat.sendMessage(text, { mentions });
    } else {
      await chat.sendMessage('‎'.repeat(5000), { mentions }); // invisível
      if (text) await chat.sendMessage(text);
    }
    return;
  }

  // Renomear grupo
  if (command === 'rename') {
    if (!await requireAdmin()) return;
    if (!chat.isGroup) return msg.reply('Comando válido em grupos.');
    await chat.setSubject(args.join(' '));
    return msg.reply('Nome do grupo alterado.');
  }

  // Alterar descrição grupo
  if (command === 'desc') {
    if (!await requireAdmin()) return;
    if (!chat.isGroup) return msg.reply('Comando válido em grupos.');
    await chat.setDescription(args.join(' '));
    return msg.reply('Descrição alterada.');
  }

  // Criar grupo (não suportado na API)
  if (command === 'creatgrup') {
    return msg.reply('Criação de grupos não suportada via API do WhatsApp-web.js.');
  }

  // Chatbot básico
  if (command === 'chatbot') {
    if (!await requireAdmin()) return;
    const sub = args[0];
    if (sub === 'on') { config.chatbot.enabled = true; saveConfig(); return msg.reply('Chatbot ativado.'); }
    if (sub === 'off') { config.chatbot.enabled = false; saveConfig(); return msg.reply('Chatbot desativado.'); }
    if (sub === 'add') {
      const text = args.slice(1).join(' ');
      const lines = text.split('\n');
      lines.forEach(line => {
        const sepIndex = line.indexOf('=');
        if (sepIndex > 0) {
          const key = line.substring(0, sepIndex).trim().toLowerCase();
          const val = line.substring(sepIndex + 1).trim();
          config.chatbot.triggers[key] = val;
        }
      });
      saveConfig();
      return msg.reply('Gatilho(s) adicionado(s).');
    }
    if (sub === 'media') {
      // !chatbot media <gatilho> <caminho>
      const gatilho = args[1];
      const caminho = args.slice(2).join(' ');
      if (!gatilho || !caminho) return msg.reply('Use: !chatbot media <gatilho> <caminho>');
      config.chatbot.media[gatilho.toLowerCase()] = caminho;
      saveConfig();
      return msg.reply('Mídia do gatilho definida.');
    }
    if (sub === 'remove') {
      const gatilho = args[1];
      if (!gatilho) return msg.reply('Informe o gatilho para remover.');
      delete config.chatbot.triggers[gatilho.toLowerCase()];
      delete config.chatbot.media[gatilho.toLowerCase()];
      saveConfig();
      return msg.reply('Gatilho removido.');
    }
    if (sub === 'list') {
      const keys = Object.keys(config.chatbot.triggers);
      if (keys.length === 0) return msg.reply('Nenhum gatilho cadastrado.');
      return msg.reply('Gatilhos:\n' + keys.join('\n'));
    }
    return msg.reply('Use !chatbot on/off | add | media | remove | list');
  }

  // Placeholder mensagens post automaticas
  if (command === 'mensege') {
    return msg.reply('Comando de postagem automática não implementado.');
  }

  // Poll - placeholder
  if (command === 'poll' || command === 'pollresult' || command === 'poll resulte') {
    return msg.reply('Comando de enquete não implementado.');
  }

  // Anti-link e antiwords ativados - checar mensagens
  if (config.antilink.enabled && config.antilink.ban && !await isGroupAdmin(chat, userId)) {
    if (/https?:\/\/\S+/gi.test(msg.body)) {
      await msg.delete(true);
      if (config.antilink.ban && chat.isGroup) await chat.removeParticipants([userId]);
      return;
    }
  }

  if (config.antiwords.enabled && config.antiwords.ban && !await isGroupAdmin(chat, userId)) {
    for (const word of config.antiwords.words) {
      if (msg.body.toLowerCase().includes(word.toLowerCase())) {
        await msg.delete(true);
        if (chat.isGroup) await chat.removeParticipants([userId]);
        return;
      }
    }
  }

  // Chatbot responder gatilhos
  if (config.chatbot.enabled) {
    const text = msg.body.toLowerCase();
    if (config.chatbot.triggers[text]) {
      if (config.chatbot.media[text] && fs.existsSync(config.chatbot.media[text])) {
        await msg.reply(MessageMedia.fromFilePath(config.chatbot.media[text]));
      } else {
        await msg.reply(config.chatbot.triggers[text]);
      }
    }
  }
});

client.initialize();
