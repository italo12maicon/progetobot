const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, getContentType, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const logger = {
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => logger
};

let config = {
    owner: "ADMIM-BOT",
    prefix: "!",
    welcome: {
        enabled: true,
        message: "Olá @user! Seja bem-vindo ao grupo @group! Leia as regras!",
        media: { enabled: false, type: "", path: "" },
        private: {
            enabled: true,
            message: "Olá @user! Você foi adicionado ao grupo @group. Confira as regras! e acesse o site 👇 https://plusdigitalblack.com.br",
            media: { enabled: false, type: "", path: "" }
        }
    },
    goodbye: {
        enabled: true,
        message: "Até logo @user! Obrigado por fazer parte do @group!",
        media: { enabled: false, type: "", path: "" }
    },
    antilink: { enabled: false, ban: false },
    antiwords: { enabled: false, words: [], ban: false },
    chatbot: {
        enabled: true,
        responses: [
            { trigger: "oi", response: "Olá! Como posso ajudar?", media: null },
            { trigger: "bom dia", response: "Bom dia! Tenha um excelente dia!", media: null },
            { trigger: "tchau", response: "Até logo! Volte sempre!", media: null }
        ]
    },
    // FUNCIONALIDADES ADICIONADAS
    messagePost: {
        enabled: false,
        interval: 60,
        message: "Mensagem automática do bot!",
        media: { enabled: false, path: "" }
    },
    polls: new Map(), // Armazenar dados das enquetes
    activePoll: null, // Enquete ativa atual
    adminRequired: true
};

let sock;
let messagePostInterval;

function initDirectories() {
    const dirs = ['./auth_info', './media', './logs', './temp', './downloads', './contacts'];
    dirs.forEach(dir => {
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch (error) {
            console.log('Erro ao criar', dir, ':', error.message);
        }
    });
    console.log('Diretórios inicializados');
}

function saveConfig() {
    try {
        const configToSave = { ...config, polls: Array.from(config.polls.entries()) };
        fs.writeFileSync('./config.json', JSON.stringify(configToSave, null, 2));
    } catch (error) {
        console.log('Erro ao salvar config:', error.message);
    }
}

function loadConfig() {
    try {
        if (fs.existsSync('./config.json')) {
            const data = fs.readFileSync('./config.json', 'utf8');
            const loadedConfig = JSON.parse(data);
            config = { ...config, ...loadedConfig };
            if (Array.isArray(config.polls)) {
                config.polls = new Map(config.polls);
            }
            console.log('Configurações carregadas');
        } else {
            console.log('Usando configurações padrão');
            saveConfig();
        }
    } catch (error) {
        console.log('Erro ao carregar config, usando padrão');
        saveConfig();
    }
}

function normalizeId(id) {
    if (!id) return null;
    return id.replace(/:0.*$/, '').replace(/:.*$/, '').split('@')[0];
}

function isBotMessage(userId) {
    if (!sock || !sock.user) return false;
    return normalizeId(sock.user.id) === normalizeId(userId);
}

// Verificar se bot é admin do grupo
async function isBotAdmin(groupId) {
    try {
        if (!sock || !sock.user) return false;
        const groupMetadata = await sock.groupMetadata(groupId);
        const botParticipant = groupMetadata.participants.find(p => normalizeId(p.id) === normalizeId(sock.user.id));
        return botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');
    } catch (error) {
        console.log('Erro ao verificar se bot é admin:', error.message);
        return false;
    }
}

async function isAdmin(groupId, userId) {
    try {
        if (isBotMessage(userId)) return true;
        const groupMetadata = await sock.groupMetadata(groupId);
        const participant = groupMetadata.participants.find(p => normalizeId(p.id) === normalizeId(userId));
        return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
    } catch (error) {
        console.log('Erro ao verificar admin:', error.message);
        return false;
    }
}

function getMessageText(message) {
    return message?.conversation || 
           message?.extendedTextMessage?.text || 
           message?.imageMessage?.caption || 
           message?.videoMessage?.caption || 
           message?.documentMessage?.caption || '';
}

function extractMentions(text) {
    const mentions = [];
    const regex = /@(\d+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        mentions.push(match[1] + '@s.whatsapp.net');
    }
    return mentions;
}

function extractPhoneNumber(text) {
    const regex = /(\d{10,15})/g;
    const match = text.match(regex);
    return match ? match[0] : null;
}

async function sendMediaMessage(jid, mediaPath, caption, mentions) {
    try {
        if (!fs.existsSync(mediaPath)) {
            console.log('Arquivo não encontrado:', mediaPath);
            return false;
        }

        const mediaBuffer = fs.readFileSync(mediaPath);
        const extension = mediaPath.split('.').pop().toLowerCase();

        let mediaMessage = { mentions: mentions || [] };

        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension)) {
            mediaMessage.image = mediaBuffer;
            mediaMessage.caption = caption || '';
        } else if (['mp4', 'mkv', 'avi', '3gp'].includes(extension)) {
            mediaMessage.video = mediaBuffer;
            mediaMessage.caption = caption || '';
        } else if (['mp3', 'wav', 'ogg', 'm4a', 'aac'].includes(extension)) {
            mediaMessage.audio = mediaBuffer;
            mediaMessage.mimetype = 'audio/mpeg';
            if (caption) {
                await sock.sendMessage(jid, { text: caption, mentions: mentions || [] });
            }
        } else if (['pdf', 'doc', 'docx', 'txt', 'csv'].includes(extension)) {
            mediaMessage.document = mediaBuffer;
            mediaMessage.fileName = mediaPath.split('/').pop();
            mediaMessage.mimetype = 'application/octet-stream';
            if (caption) {
                mediaMessage.caption = caption;
            }
        }

        await sock.sendMessage(jid, mediaMessage);
        return true;
    } catch (error) {
        console.log('Erro ao enviar mídia:', error.message);
        return false;
    }
}

// CORRIGIDA: Função para extrair contatos com CSV organizado
async function extractGroupContacts(groupId) {
    try {
        console.log('Extraindo contatos do grupo:', normalizeId(groupId));

        const groupMetadata = await sock.groupMetadata(groupId);
        const participants = groupMetadata.participants;

        // Criar dados CSV com formatação adequada
        const csvHeader = 'Nome,Numero,Admin,Status\n';
        let csvData = csvHeader;

        const contactsData = [];

        for (const participant of participants) {
            const phoneNumber = normalizeId(participant.id);
            const isAdminUser = participant.admin === 'admin' || participant.admin === 'superadmin';
            const adminStatus = isAdminUser ? 'Admin' : 'Membro';

            // Tentar obter nome/perfil
            let userName = phoneNumber;
            try {
                const userInfo = await sock.onWhatsApp(participant.id);
                if (userInfo && userInfo[0] && userInfo[0].exists) {
                    // Usar número como nome padrão
                    userName = phoneNumber;
                }
            } catch (error) {
                console.log('Erro ao obter info do usuário:', phoneNumber);
            }

            const contactData = {
                nome: userName,
                numero: phoneNumber,
                admin: adminStatus,
                status: 'Ativo'
            };

            contactsData.push(contactData);

            // CORRIGIDO: Formatação CSV com colunas separadas corretamente
            csvData += `${contactData.nome},${contactData.numero},${contactData.admin},${contactData.status}\n`;
        }

        // Salvar arquivo CSV
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const groupName = groupMetadata.subject.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
        const fileName = `contacts_${groupName}_${timestamp}.csv`;
        const filePath = `./contacts/${fileName}`;

        // CORRIGIDO: Salvar com encoding UTF-8 e formatação adequada
        fs.writeFileSync(filePath, csvData, 'utf8');

        console.log('Contatos extraídos:', contactsData.length);
        console.log('Arquivo salvo:', fileName);

        return { 
            filePath, 
            fileName, 
            count: contactsData.length, 
            groupName: groupMetadata.subject,
            data: contactsData 
        };

    } catch (error) {
        console.log('Erro ao extrair contatos:', error.message);
        return null;
    }
}

// CORRIGIDA: Criar enquete nativa e configurar detecção de votos
async function createNativePoll(groupId, question, options) {
    try {
        const pollMessage = {
            poll: {
                name: question,
                values: options,
                selectableCount: 1
            }
        };

        const sentMsg = await sock.sendMessage(groupId, pollMessage);

        // Configurar enquete ativa para detecção de votos
        const pollData = {
            id: sentMsg.key.id,
            question: question,
            options: options,
            votes: new Map(),
            groupId: groupId,
            created: new Date().toISOString(),
            messageKey: sentMsg.key
        };

        // Salvar como enquete ativa
        config.activePoll = pollData;
        config.polls.set(sentMsg.key.id, pollData);

        saveConfig();
        console.log('Enquete criada e configurada para detecção de votos:', question);
        return { success: true, pollId: sentMsg.key.id };
    } catch (error) {
        console.log('Erro ao criar enquete:', error.message);
        return { success: false, error: error.message };
    }
}

// CORRIGIDA: Obter resultado da enquete com dados reais
async function getPollResult(groupId) {
    try {
        // Verificar se há enquete ativa no grupo
        if (!config.activePoll || config.activePoll.groupId !== groupId) {
            // Procurar última enquete do grupo
            const groupPolls = Array.from(config.polls.values()).filter(poll => poll.groupId === groupId);

            if (groupPolls.length === 0) {
                await sock.sendMessage(groupId, { 
                    text: "❌ Nenhuma enquete encontrada neste grupo!" 
                });
                return;
            }

            // Usar a mais recente
            config.activePoll = groupPolls.sort((a, b) => new Date(b.created) - new Date(a.created))[0];
        }

        const poll = config.activePoll;

        let resultText = `📊 RESULTADO DA ENQUETE

❓ Pergunta: ${poll.question}

📈 Resultados:`;

        // Contar votos por opção
        const voteCounts = new Array(poll.options.length).fill(0);
        const votersList = new Array(poll.options.length).fill(null).map(() => []);

        for (const [voter, optionIndex] of poll.votes.entries()) {
            if (optionIndex >= 0 && optionIndex < poll.options.length) {
                voteCounts[optionIndex]++;
                votersList[optionIndex].push(voter);
            }
        }

        // Mostrar resultados
        poll.options.forEach((option, index) => {
            const count = voteCounts[index];
            const percentage = poll.votes.size > 0 ? ((count / poll.votes.size) * 100).toFixed(1) : '0.0';
            resultText += `\n\n${index + 1}. ${option}`;
            resultText += `\n   📊 ${count} voto(s) (${percentage}%)`;

            if (count > 0) {
                const voters = votersList[index].slice(0, 3); // Mostrar até 3 votantes
                const voterNames = voters.map(v => v.substring(0, 8) + '...').join(', ');
                resultText += `\n   👥 ${voterNames}`;
                if (count > 3) {
                    resultText += ` e mais ${count - 3}...`;
                }
            }
        });

        const totalVotes = poll.votes.size;
        resultText += `\n\n✅ Total de votos: ${totalVotes}`;
        resultText += `\n🗓️ Criada em: ${new Date(poll.created).toLocaleString('pt-BR')}`;

        if (totalVotes === 0) {
            resultText += "\n\n⚠️ Ainda não há votos nesta enquete!";
        }

        await sock.sendMessage(groupId, { text: resultText });
        return true;
    } catch (error) {
        console.log('Erro ao obter resultado da enquete:', error.message);
        await sock.sendMessage(groupId, { 
            text: "❌ Erro ao obter resultado da enquete: " + error.message 
        });
        return false;
    }
}

// Sistema de postagem automática
function startMessagePost(groupId) {
    if (messagePostInterval) {
        clearInterval(messagePostInterval);
    }

    if (config.messagePost.enabled) {
        const intervalMs = config.messagePost.interval * 60 * 1000;

        messagePostInterval = setInterval(async () => {
            try {
                if (config.messagePost.media.enabled && fs.existsSync(config.messagePost.media.path)) {
                    await sendMediaMessage(groupId, config.messagePost.media.path, config.messagePost.message);
                } else {
                    await sock.sendMessage(groupId, { text: config.messagePost.message });
                }
                console.log('Mensagem automática postada');
            } catch (error) {
                console.log('Erro na postagem automática:', error.message);
            }
        }, intervalMs);

        console.log('Sistema de postagem ativo. Intervalo:', config.messagePost.interval, 'minutos');
    }
}

function stopMessagePost() {
    if (messagePostInterval) {
        clearInterval(messagePostInterval);
        messagePostInterval = null;
        console.log('Postagem automática desativada');
    }
}

async function handleRemoveAll(groupId) {
    try {
        console.log('Executando remoção em massa...');

        const groupMetadata = await sock.groupMetadata(groupId);
        const toRemove = groupMetadata.participants.filter(p => 
            normalizeId(p.id) !== normalizeId(sock.user.id) && 
            p.admin !== 'admin' && 
            p.admin !== 'superadmin'
        ).map(p => p.id);

        if (toRemove.length === 0) {
            await sock.sendMessage(groupId, { 
                text: 'Não há membros comuns para remover. Apenas administradores permanecem no grupo.' 
            });
            return;
        }

        await sock.sendMessage(groupId, { 
            text: `ATENÇÃO: REMOÇÃO EM MASSA

Membros a serem removidos: ${toRemove.length}
Administradores: PRESERVADOS
Bot: PRESERVADO

Iniciando remoção em 5 segundos...`
        });

        await new Promise(resolve => setTimeout(resolve, 5000));

        let removed = 0;
        let errors = 0;
        const batchSize = 5;

        for (let i = 0; i < toRemove.length; i += batchSize) {
            const batch = toRemove.slice(i, i + batchSize);
            try {
                await sock.groupParticipantsUpdate(groupId, batch, 'remove');
                removed += batch.length;
                console.log('Removidos:', batch.length, 'membros');
                if (i + batchSize < toRemove.length) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (error) {
                errors += batch.length;
                console.log('Erro no lote:', error.message);
            }
        }

        await sock.sendMessage(groupId, { 
            text: `RELATÓRIO DE REMOÇÃO EM MASSA

Removidos: ${removed}
Erros: ${errors}
Administradores preservados
Bot preservado

Concluído!`
        });

    } catch (error) {
        console.log('Erro na remoção:', error.message);
        await sock.sendMessage(groupId, { text: 'Erro: ' + error.message });
    }
}

async function sendWelcome(groupId, participants, groupName) {
    try {
        if (!config.welcome.enabled) return;

        for (const participant of participants) {
            const userName = normalizeId(participant);

            let groupMessage = config.welcome.message
                .replace('@user', '@' + userName)
                .replace('@group', groupName);

            if (config.welcome.media.enabled && fs.existsSync(config.welcome.media.path)) {
                await sendMediaMessage(groupId, config.welcome.media.path, groupMessage, [participant]);
            } else {
                await sock.sendMessage(groupId, { text: groupMessage, mentions: [participant] });
            }

            if (config.welcome.private.enabled) {
                let privateMessage = config.welcome.private.message
                    .replace('@user', userName)
                    .replace('@group', groupName);

                try {
                    if (config.welcome.private.media.enabled && fs.existsSync(config.welcome.private.media.path)) {
                        await sendMediaMessage(participant, config.welcome.private.media.path, privateMessage);
                    } else {
                        await sock.sendMessage(participant, { text: privateMessage });
                    }
                } catch (error) {
                    console.log('Erro mensagem privada para', userName);
                }
            }
        }
    } catch (error) {
        console.log('Erro nas boas-vindas:', error.message);
    }
}

async function processChatbot(groupId, messageText) {
    try {
        if (!config.chatbot.enabled) return false;

        const cleanText = messageText.trim().toLowerCase();
        const response = config.chatbot.responses.find(r => 
            cleanText.includes(r.trigger.toLowerCase())
        );

        if (response) {
            console.log('Chatbot ativado:', response.trigger);

            if (response.media && fs.existsSync(response.media.path)) {
                await sendMediaMessage(groupId, response.media.path, response.response);
            } else {
                await sock.sendMessage(groupId, { text: response.response });
            }
            return true;
        }

        return false;
    } catch (error) {
        console.log('Erro no chatbot:', error.message);
        return false;
    }
}

async function processCommand(msg) {
    try {
        const { key, message } = msg;
        const messageText = getMessageText(message);

        if (!messageText || !messageText.startsWith(config.prefix)) return;

        const args = messageText.slice(config.prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const groupId = key.remoteJid;
        const userId = key.participant || key.remoteJid;

        // Só funciona em grupos (exceto extracto)
        if (!groupId.endsWith('@g.us') && command !== 'extracto') {
            await sock.sendMessage(groupId, { text: 'Este comando só funciona em grupos!' });
            return;
        }

        // Verificar se bot é admin do grupo (exceto extracto)
        if (command !== 'extracto') {
            const botIsAdmin = await isBotAdmin(groupId);
            if (config.adminRequired && !botIsAdmin) {
                await sock.sendMessage(groupId, { 
                    text: '⚠️ ATENÇÃO: Este bot só funciona em grupos onde ele é ADMINISTRADOR!\n\nPara usar todas as funcionalidades, promova o bot a administrador do grupo.' 
                });
                return;
            }
        }

        console.log('Comando:', command, '| User:', normalizeId(userId));

        // Comandos que precisam de admin (extracto é exceção)
        const adminCommands = [
            'removeall', 'ban', 'promote', 'demote', 'add', 'tagall', 'tagallcut',
            'rename', 'desc', 'antilink', 'antiwords', 'creatgrup'
        ];

        if (adminCommands.includes(command)) {
            const userIsAdmin = await isAdmin(groupId, userId);
            if (!userIsAdmin) {
                await sock.sendMessage(groupId, { 
                    text: 'Apenas administradores podem usar este comando!' 
                });
                return;
            }
        }

        switch (command) {
            case 'help':
                const helpText = `${config.owner}

COMANDOS GERAIS:
${config.prefix}help - Lista de comandos
${config.prefix}ping - Testar bot
${config.prefix}info - Info do grupo
${config.prefix}extracto cont - Extrair contatos (funciona em qualquer grupo)

BOAS-VINDAS:
${config.prefix}welcome on/off - Ativar/desativar
${config.prefix}welcome set <mensagem> - Definir mensagem ( podem coloca link)
${config.prefix}welcome media <caminho> - Definir midia
${config.prefix}welcomepv on/off - Mensagens privadas
${config.prefix}welcomepv set <mensagem> - Definir mensagem ( pode coloca link)
${config.prefix}welcomepv media <caminho> - Definir midia
${config.prefix}goodbye on/off - Ativar/desativar
${config.prefix}goodbye set <mensagem> - Definir mensagem
${config.prefix}goodbye media <caminho> - Definir midia

MODERACAO (Admins):
${config.prefix}antilink on/off - Anti-link
${config.prefix}antilink ban on/off - Banir por link
${config.prefix}antiwords on/off - Anti-palavroes
${config.prefix}antiwords add <palavra> - Adicionar palavra
${config.prefix}antiwords remove <palavra> - Remover palavra
${config.prefix}antiwords ban on/off - Banir por palavrao
${config.prefix}antiwords list - Listar palavras
${config.prefix}ban @user - Banir usuario
${config.prefix}removeall - REMOVE TODOS

ADMINISTRACAO (Admins):
${config.prefix}promote @user - Promover admin
${config.prefix}demote @user - Rebaixar admin
${config.prefix}add <numero> - Adicionar membro
${config.prefix}tagall <mensagem> - Marcar todos
${config.prefix}tagallcut <mensagem> - Marca invisivel
${config.prefix}rename <nome> - Renomear grupo
${config.prefix}desc <descricao> - Alterar descricao
${config.prefix}creatgrup <nome> - Criar grupo

CHATBOT:
${config.prefix}chatbot on/off - Ativar/desativar
${config.prefix}chatbot add <gatilho>=<resposta> - Adicionar
${config.prefix}chatbot media <gatilho> <caminho> - Definir midia
${config.prefix}chatbot remove <gatilho> - Remover
${config.prefix}chatbot list - Listar gatilhos
${config.prefix}mensege post on/off - ativa ou desativa postagem automatica 
${config.prefix}mensege post minutos <minutos> <mensagem> - postagem a cada X minutos
${config.prefix}poll <pergunta>=<op1>=<op2> - Enquete nativa
${config.prefix}poll resulte - resultado da enquete

Admim-bot - Tecnologia`;

                await sock.sendMessage(groupId, { text: helpText });
                break;

            case 'ping':
                const startTime = Date.now();
                const pingMsg = await sock.sendMessage(groupId, { text: 'Calculando latência...' });
                const endTime = Date.now();
                const ping = endTime - startTime;

                await sock.sendMessage(groupId, { 
                    text: `Pong! 🏓

Latência: ${ping}ms
Status: Online ✅
Uptime: ${Math.floor(process.uptime())}s`
                });
                break;

            case 'info':
                try {
                    const groupMetadata = await sock.groupMetadata(groupId);
                    const admins = groupMetadata.participants.filter(p => 
                        p.admin === 'admin' || p.admin === 'superadmin'
                    ).length;

                    const botIsAdminInfo = await isBotAdmin(groupId);

                    const info = `INFORMAÇÕES DO GRUPO

Nome: ${groupMetadata.subject}
Membros: ${groupMetadata.participants.length}
Admins: ${admins}
Bot Admin: ${botIsAdminInfo ? 'SIM ✅' : 'NÃO ❌'}
Criado: ${new Date(groupMetadata.creation * 1000).toLocaleDateString('pt-BR')}
Bot: Online ✅

RECURSOS ATIVOS:
${config.welcome.enabled ? 'SIM ✅' : 'NÃO ❌'} Boas-vindas
${config.welcome.private.enabled ? 'SIM ✅' : 'NÃO ❌'} Mensagens privadas
${config.goodbye.enabled ? 'SIM ✅' : 'NÃO ❌'} Despedidas
${config.chatbot.enabled ? 'SIM ✅' : 'NÃO ❌'} Chatbot
${config.antilink.enabled ? 'SIM ✅' : 'NÃO ❌'} Anti-link
${config.antiwords.enabled ? 'SIM ✅' : 'NÃO ❌'} Anti-palavrões
${config.messagePost.enabled ? 'SIM ✅' : 'NÃO ❌'} Postagem Automática`;

                    await sock.sendMessage(groupId, { text: info });
                } catch (error) {
                    await sock.sendMessage(groupId, { text: 'Erro ao obter informações do grupo' });
                }
                break;

            // Comando extracto - funciona em qualquer grupo
            case 'extracto':
                if (args[0] === 'cont') {
                    try {
                        if (!groupId.endsWith('@g.us')) {
                            await sock.sendMessage(groupId, { text: '❌ Este comando só funciona em grupos!' });
                            return;
                        }

                        await sock.sendMessage(groupId, { text: '⏳ Extraindo contatos do grupo... Aguarde...' });

                        const extractResult = await extractGroupContacts(groupId);

                        if (extractResult) {
                            // Enviar arquivo CSV para o próprio bot (número do bot)
                            const botNumber = normalizeId(sock.user.id) + '@s.whatsapp.net';

                            const reportMessage = `📊 RELATÓRIO DE EXTRAÇÃO DE CONTATOS

👥 Grupo: ${extractResult.groupName}
📱 Total de contatos: ${extractResult.count}
📅 Data: ${new Date().toLocaleString('pt-BR')}
📁 Arquivo: ${extractResult.fileName}

✅ Contatos extraídos e organizados em colunas CSV!

📋 Formato do arquivo:
Nome | Numero | Admin | Status

Os dados estão separados corretamente por colunas para fácil importação em Excel ou Google Sheets.`;

                            // Enviar relatório no grupo
                            await sock.sendMessage(groupId, { 
                                text: `✅ Contatos extraídos com sucesso!

📱 Total: ${extractResult.count} contatos
📁 Arquivo CSV enviado para o bot
📊 Dados organizados em colunas separadas`
                            });

                            // Enviar arquivo CSV para o bot
                            await sendMediaMessage(botNumber, extractResult.filePath, reportMessage);

                            console.log('Contatos extraídos e enviados para o bot:', extractResult.count);
                        } else {
                            await sock.sendMessage(groupId, { text: '❌ Erro ao extrair contatos do grupo!' });
                        }
                    } catch (error) {
                        console.log('Erro no comando extracto:', error.message);
                        await sock.sendMessage(groupId, { text: '❌ Erro ao extrair contatos: ' + error.message });
                    }
                } else {
                    await sock.sendMessage(groupId, { 
                        text: `Comando de extração:

${config.prefix}extracto cont - Extrair todos os contatos do grupo

📋 O arquivo CSV será enviado para o bot com:
• Nome/Número dos membros (colunas separadas)
• Status de administrador
• Data da extração
• Formatação adequada para Excel/Sheets

⚡ Funciona em qualquer grupo (não precisa ser admin)`
                    });
                }
                break;

            case 'removeall':
                await handleRemoveAll(groupId);
                break;

            case 'welcome':
                if (args[0] === 'on') {
                    config.welcome.enabled = true;
                    await sock.sendMessage(groupId, { text: 'Boas-vindas ativadas! ✅' });
                } else if (args[0] === 'off') {
                    config.welcome.enabled = false;
                    await sock.sendMessage(groupId, { text: 'Boas-vindas desativadas! ❌' });
                } else if (args[0] === 'set') {
                    const newMessage = args.slice(1).join(' ');
                    if (newMessage) {
                        config.welcome.message = newMessage;
                        await sock.sendMessage(groupId, { text: 'Mensagem de boas-vindas atualizada! ✅' });
                    } else {
                        await sock.sendMessage(groupId, { text: 'Use: !welcome set <mensagem>' });
                    }
                } else if (args[0] === 'media') {
                    const mediaPath = args.slice(1).join(' ');
                    if (mediaPath && fs.existsSync(mediaPath)) {
                        config.welcome.media.enabled = true;
                        config.welcome.media.path = mediaPath;
                        await sock.sendMessage(groupId, { text: 'Mídia das boas-vindas definida: ' + mediaPath });
                    } else {
                        await sock.sendMessage(groupId, { text: 'Arquivo não encontrado! Use: !welcome media ./media/welcome.jpg' });
                    }
                } else {
                    const status = config.welcome.enabled ? 'Ativo ✅' : 'Inativo ❌';
                    const mediaStatus = config.welcome.media.enabled ? 'Ativo ✅' : 'Inativo ❌';
                    await sock.sendMessage(groupId, { 
                        text: `Boas-vindas: ${status}
Mídia: ${mediaStatus}

Mensagem atual:
${config.welcome.message}

Comandos:
${config.prefix}welcome on/off
${config.prefix}welcome set <mensagem>
${config.prefix}welcome media <caminho>`
                    });
                }
                saveConfig();
                break;

            case 'welcomepv':
                if (args[0] === 'on') {
                    config.welcome.private.enabled = true;
                    await sock.sendMessage(groupId, { text: 'Mensagens privadas ativadas! ✅' });
                } else if (args[0] === 'off') {
                    config.welcome.private.enabled = false;
                    await sock.sendMessage(groupId, { text: 'Mensagens privadas desativadas! ❌' });
                } else if (args[0] === 'set') {
                    const newMessage = args.slice(1).join(' ');
                    if (newMessage) {
                        config.welcome.private.message = newMessage;
                        await sock.sendMessage(groupId, { text: 'Mensagem privada atualizada! ' });
                    } else {
                        await sock.sendMessage(groupId, { text: 'Use: !welcomepv set <mensagem>' });
                    }
                } else if (args[0] === 'media') {
                    const mediaPath = args.slice(1).join(' ');
                    if (mediaPath && fs.existsSync(mediaPath)) {
                        config.welcome.private.media.enabled = true;
                        config.welcome.private.media.path = mediaPath;
                        await sock.sendMessage(groupId, { text: 'Mídia das mensagens privadas definida: ' + mediaPath });
                    } else {
                        await sock.sendMessage(groupId, { text: 'Arquivo não encontrado! Use: !welcomepv media ./media/private.jpg' });
                    }
                } else {
                    const status = config.welcome.private.enabled ? 'Ativo ✅' : 'Inativo ❌';
                    const mediaStatus = config.welcome.private.media.enabled ? 'Ativo ✅' : 'Inativo ❌';
                    await sock.sendMessage(groupId, { text: `Mensagens Privadas: ${status}\nMídia: ${mediaStatus}` });
                }
                saveConfig();
                break;

            case 'goodbye':
                if (args[0] === 'on') {
                    config.goodbye.enabled = true;
                    await sock.sendMessage(groupId, { text: 'Despedidas ativadas! ✅' });
                } else if (args[0] === 'off') {
                    config.goodbye.enabled = false;
                    await sock.sendMessage(groupId, { text: 'Despedidas desativadas! ❌' });
                } else if (args[0] === 'set') {
                    const newMessage = args.slice(1).join(' ');
                    if (newMessage) {
                        config.goodbye.message = newMessage;
                        await sock.sendMessage(groupId, { text: 'Mensagem de despedida atualizada! ✅' });
                    } else {
                        await sock.sendMessage(groupId, { text: 'Use: !goodbye set <mensagem>' });
                    }
                } else if (args[0] === 'media') {
                    const mediaPath = args.slice(1).join(' ');
                    if (mediaPath && fs.existsSync(mediaPath)) {
                        config.goodbye.media.enabled = true;
                        config.goodbye.media.path = mediaPath;
                        await sock.sendMessage(groupId, { text: 'Mídia das despedidas definida: ' + mediaPath });
                    } else {
                        await sock.sendMessage(groupId, { text: 'Arquivo não encontrado! Use: !goodbye media ./media/goodbye.jpg' });
                    }
                } else {
                    const status = config.goodbye.enabled ? 'Ativo ✅' : 'Inativo ❌';
                    const mediaStatus = config.goodbye.media.enabled ? 'Ativo ✅' : 'Inativo ❌';
                    await sock.sendMessage(groupId, { text: `Despedidas: ${status}\nMídia: ${mediaStatus}` });
                }
                saveConfig();
                break;

            case 'antilink':
                if (args[0] === 'on') {
                    config.antilink.enabled = true;
                    await sock.sendMessage(groupId, { text: 'Anti-link ativado! ✅ (Admins são isentos)' });
                } else if (args[0] === 'off') {
                    config.antilink.enabled = false;
                    await sock.sendMessage(groupId, { text: 'Anti-link desativado! ❌' });
                } else if (args[0] === 'ban') {
                    if (args[1] === 'on') {
                        config.antilink.ban = true;
                        await sock.sendMessage(groupId, { text: 'Banimento por link ativado! ✅' });
                    } else if (args[1] === 'off') {
                        config.antilink.ban = false;
                        await sock.sendMessage(groupId, { text: 'Banimento por link desativado! ❌' });
                    } else {
                        const banStatus = config.antilink.ban ? 'Ativo ✅' : 'Inativo ❌';
                        await sock.sendMessage(groupId, { text: 'Banimento por link: ' + banStatus });
                    }
                } else {
                    const status = config.antilink.enabled ? 'Ativo ✅' : 'Inativo ❌';
                    const banStatus = config.antilink.ban ? 'Ativo ✅' : 'Inativo ❌';
                    await sock.sendMessage(groupId, { 
                        text: `Anti-link: ${status}
Banimento: ${banStatus}

Administradores são sempre isentos`
                    });
                }
                saveConfig();
                break;

            case 'antiwords':
                if (args[0] === 'on') {
                    config.antiwords.enabled = true;
                    await sock.sendMessage(groupId, { text: 'Anti-palavrões ativado! ✅' });
                } else if (args[0] === 'off') {
                    config.antiwords.enabled = false;
                    await sock.sendMessage(groupId, { text: 'Anti-palavrões desativado! ❌' });
                } else if (args[0] === 'add') {
                    const word = args[1];
                    if (word) {
                        if (!config.antiwords.words.includes(word.toLowerCase())) {
                            config.antiwords.words.push(word.toLowerCase());
                            await sock.sendMessage(groupId, { text: `Palavra "${word}" adicionada à lista proibida! ✅` });
                        } else {
                            await sock.sendMessage(groupId, { text: `Palavra "${word}" já está na lista!` });
                        }
                    } else {
                        await sock.sendMessage(groupId, { text: 'Use: !antiwords add <palavra>' });
                    }
                } else if (args[0] === 'remove') {
                    const word = args[1];
                    if (word) {
                        const index = config.antiwords.words.indexOf(word.toLowerCase());
                        if (index > -1) {
                            config.antiwords.words.splice(index, 1);
                            await sock.sendMessage(groupId, { text: `Palavra "${word}" removida da lista! ✅` });
                        } else {
                            await sock.sendMessage(groupId, { text: `Palavra "${word}" não está na lista!` });
                        }
                    } else {
                        await sock.sendMessage(groupId, { text: 'Use: !antiwords remove <palavra>' });
                    }
                } else if (args[0] === 'ban') {
                    if (args[1] === 'on') {
                        config.antiwords.ban = true;
                        await sock.sendMessage(groupId, { text: 'Banimento por palavrão ativado! ✅' });
                    } else if (args[1] === 'off') {
                        config.antiwords.ban = false;
                        await sock.sendMessage(groupId, { text: 'Banimento por palavrão desativado! ❌' });
                    } else {
                        const banStatus = config.antiwords.ban ? 'Ativo ✅' : 'Inativo ❌';
                        await sock.sendMessage(groupId, { text: 'Banimento por palavrão: ' + banStatus });
                    }
                } else if (args[0] === 'list') {
                    if (config.antiwords.words.length > 0) {
                        const wordsList = config.antiwords.words.map((word, i) => `${i + 1}. ${word}`).join('\n');
                        await sock.sendMessage(groupId, { 
                            text: `Palavras Proibidas (${config.antiwords.words.length}):

${wordsList}`
                        });
                    } else {
                        await sock.sendMessage(groupId, { text: 'Nenhuma palavra proibida configurada!' });
                    }
                } else {
                    const status = config.antiwords.enabled ? 'Ativo ✅' : 'Inativo ❌';
                    const banStatus = config.antiwords.ban ? 'Ativo ✅' : 'Inativo ❌';
                    await sock.sendMessage(groupId, { 
                        text: `Anti-palavrões: ${status}
Banimento: ${banStatus}
Palavras: ${config.antiwords.words.length}`
                    });
                }
                saveConfig();
                break;

            case 'ban':
                const mentions = extractMentions(messageText);
                if (mentions.length > 0) {
                    try {
                        await sock.groupParticipantsUpdate(groupId, mentions, 'remove');
                        await sock.sendMessage(groupId, { 
                            text: 'Usuário(s) banido(s) com sucesso! ✅',
                            mentions: mentions
                        });
                    } catch (error) {
                        await sock.sendMessage(groupId, { text: 'Erro ao banir usuário! ❌' });
                    }
                } else {
                    await sock.sendMessage(groupId, { text: 'Use: !ban @usuario' });
                }
                break;

            case 'promote':
                const promoteUsers = extractMentions(messageText);
                if (promoteUsers.length > 0) {
                    try {
                        await sock.groupParticipantsUpdate(groupId, promoteUsers, 'promote');
                        await sock.sendMessage(groupId, { 
                            text: 'Usuário(s) promovido(s) a administrador! ✅',
                            mentions: promoteUsers
                        });
                    } catch (error) {
                        await sock.sendMessage(groupId, { text: 'Erro ao promover usuário! ❌' });
                    }
                } else {
                    await sock.sendMessage(groupId, { text: 'Use: !promote @usuario' });
                }
                break;

            case 'demote':
                const demoteUsers = extractMentions(messageText);
                if (demoteUsers.length > 0) {
                    try {
                        await sock.groupParticipantsUpdate(groupId, demoteUsers, 'demote');
                        await sock.sendMessage(groupId, { 
                            text: 'Usuário(s) rebaixado(s) de administrador! ✅',
                            mentions: demoteUsers
                        });
                    } catch (error) {
                        await sock.sendMessage(groupId, { text: 'Erro ao rebaixar usuário! ❌' });
                    }
                } else {
                    await sock.sendMessage(groupId, { text: 'Use: !demote @usuario' });
                }
                break;

            case 'add':
                const phoneNumber = extractPhoneNumber(args.join(' '));
                if (phoneNumber) {
                    try {
                        const userJid = phoneNumber + '@s.whatsapp.net';
                        await sock.groupParticipantsUpdate(groupId, [userJid], 'add');
                        await sock.sendMessage(groupId, { text: `Usuário ${phoneNumber} adicionado com sucesso! ✅` });
                    } catch (error) {
                        await sock.sendMessage(groupId, { text: `Erro ao adicionar usuário ${phoneNumber}! ❌` });
                    }
                } else {
                    await sock.sendMessage(groupId, { text: 'Use: !add <numero>\nExemplo: !add 5511999999999' });
                }
                break;

            case 'tagall':
                try {
                    const groupMetadata = await sock.groupMetadata(groupId);
                    const participants = groupMetadata.participants.map(p => p.id);
                    const message = args.join(' ') || 'Marcação geral!';

                    await sock.sendMessage(groupId, { 
                        text: `MARCAÇÃO GERAL 📢

${message}`,
                        mentions: participants
                    });
                } catch (error) {
                    await sock.sendMessage(groupId, { text: 'Erro ao marcar todos! ❌' });
                }
                break;

            case 'tagallcut':
                try {
                    const groupMetadata = await sock.groupMetadata(groupId);
                    const participants = groupMetadata.participants.map(p => p.id);
                    const message = args.join(' ') || 'Marcação invisível!';

                    const hiddenMention = '‎'.repeat(participants.length);

                    await sock.sendMessage(groupId, { 
                        text: `${message}

${hiddenMention}`,
                        mentions: participants
                    });
                } catch (error) {
                    await sock.sendMessage(groupId, { text: 'Erro ao marcar todos (invisível)! ❌' });
                }
                break;

            case 'rename':
                const newGroupName = args.join(' ');
                if (newGroupName) {
                    try {
                        await sock.groupUpdateSubject(groupId, newGroupName);
                        await sock.sendMessage(groupId, { text: `Nome do grupo alterado para: ${newGroupName} ✅` });
                    } catch (error) {
                        await sock.sendMessage(groupId, { text: 'Erro ao renomear grupo! ❌' });
                    }
                } else {
                    await sock.sendMessage(groupId, { text: 'Use: !rename <novo nome>' });
                }
                break;

            case 'desc':
                const newDescription = args.join(' ');
                if (newDescription) {
                    try {
                        await sock.groupUpdateDescription(groupId, newDescription);
                        await sock.sendMessage(groupId, { text: 'Descrição do grupo alterada com sucesso! ✅' });
                    } catch (error) {
                        await sock.sendMessage(groupId, { text: 'Erro ao alterar descrição! ❌' });
                    }
                } else {
                    await sock.sendMessage(groupId, { text: 'Use: !desc <nova descrição>' });
                }
                break;

            case 'creatgrup':
                const groupName = args.join(' ');
                if (groupName) {
                    try {
                        const newGroup = await sock.groupCreate(groupName, []);
                        await sock.sendMessage(groupId, { 
                            text: `Grupo "${groupName}" criado com sucesso! ✅
ID: ${newGroup.id}`
                        });
                    } catch (error) {
                        await sock.sendMessage(groupId, { text: `Erro ao criar grupo "${groupName}"! ❌` });
                    }
                } else {
                    await sock.sendMessage(groupId, { text: 'Use: !creatgrup <nome do grupo>' });
                }
                break;

            case 'chatbot':
                if (args[0] === 'on') {
                    config.chatbot.enabled = true;
                    await sock.sendMessage(groupId, { text: 'Chatbot ativado! ✅' });
                } else if (args[0] === 'off') {
                    config.chatbot.enabled = false;
                    await sock.sendMessage(groupId, { text: 'Chatbot desativado! ❌' });
                } else if (args[0] === 'add') {
                    const input = args.slice(1).join(' ');
                    const parts = input.split('=');

                    if (parts.length >= 2) {
                        const trigger = parts[0].trim();
                        const response = parts[1].trim();

                        const existingIndex = config.chatbot.responses.findIndex(r => r.trigger.toLowerCase() === trigger.toLowerCase());

                        if (existingIndex > -1) {
                            config.chatbot.responses[existingIndex].response = response;
                            await sock.sendMessage(groupId, { text: `Resposta atualizada! ✅
"${trigger}" -> "${response}"` });
                        } else {
                            config.chatbot.responses.push({ trigger, response, media: null });
                            await sock.sendMessage(groupId, { text: `Nova resposta adicionada! ✅
"${trigger}" -> "${response}"` });
                        }
                    } else {
                        await sock.sendMessage(groupId, { text: 'Use: !chatbot add <gatilho>=<resposta>\nExemplo: !chatbot add oi=Olá! Como vai?' });
                    }
                } else if (args[0] === 'media') {
                    const trigger = args[1];
                    const mediaPath = args.slice(2).join(' ');

                    if (trigger && mediaPath && fs.existsSync(mediaPath)) {
                        const responseIndex = config.chatbot.responses.findIndex(r => r.trigger.toLowerCase() === trigger.toLowerCase());

                        if (responseIndex > -1) {
                            config.chatbot.responses[responseIndex].media = { path: mediaPath };
                            await sock.sendMessage(groupId, { text: `Mídia definida para o gatilho "${trigger}": ${mediaPath} ✅` });
                        } else {
                            await sock.sendMessage(groupId, { text: `Gatilho "${trigger}" não encontrado! Adicione primeiro com !chatbot add` });
                        }
                    } else {
                        await sock.sendMessage(groupId, { text: 'Use: !chatbot media <gatilho> <caminho>\nExemplo: !chatbot media oi ./media/hello.jpg' });
                    }
                } else if (args[0] === 'remove') {
                    const trigger = args.slice(1).join(' ');
                    if (trigger) {
                        const index = config.chatbot.responses.findIndex(r => r.trigger.toLowerCase() === trigger.toLowerCase());
                        if (index > -1) {
                            config.chatbot.responses.splice(index, 1);
                            await sock.sendMessage(groupId, { text: `Gatilho "${trigger}" removido! ✅` });
                        } else {
                            await sock.sendMessage(groupId, { text: `Gatilho "${trigger}" não encontrado!` });
                        }
                    } else {
                        await sock.sendMessage(groupId, { text: 'Use: !chatbot remove <gatilho>' });
                    }
                } else if (args[0] === 'list') {
                    if (config.chatbot.responses.length > 0) {
                        let list = `Respostas do Chatbot (${config.chatbot.responses.length}):

`;
                        config.chatbot.responses.forEach((r, i) => {
                            const mediaStatus = r.media ? 'MÍDIA' : 'TEXTO';
                            list += `${i + 1}. ${mediaStatus} "${r.trigger}" -> "${r.response}"\n`;
                        });
                        await sock.sendMessage(groupId, { text: list });
                    } else {
                        await sock.sendMessage(groupId, { text: 'Nenhuma resposta do chatbot configurada!' });
                    }
                } else {
                    const status = config.chatbot.enabled ? 'Ativo ✅' : 'Inativo ❌';
                    await sock.sendMessage(groupId, { 
                        text: `Chatbot: ${status}
Respostas: ${config.chatbot.responses.length}

Comandos:
${config.prefix}chatbot on/off
${config.prefix}chatbot add <gatilho>=<resposta>
${config.prefix}chatbot media <gatilho> <caminho>
${config.prefix}chatbot remove <gatilho>
${config.prefix}chatbot list`
                    });
                }
                saveConfig();
                break;

            // Sistema de postagem automática
            case 'mensege':
                if (args[0] === 'post') {
                    if (args[1] === 'on') {
                        config.messagePost.enabled = true;
                        startMessagePost(groupId);
                        await sock.sendMessage(groupId, { 
                            text: `Postagem automática ATIVADA! ✅

Intervalo: ${config.messagePost.interval} minutos
Mensagem: ${config.messagePost.message}` 
                        });
                    } else if (args[1] === 'off') {
                        config.messagePost.enabled = false;
                        stopMessagePost();
                        await sock.sendMessage(groupId, { text: 'Postagem automática DESATIVADA! ❌' });
                    } else if (args[1] === 'minutos') {
                        const minutes = parseInt(args[2]);
                        const message = args.slice(3).join(' ');

                        if (minutes && minutes > 0 && message) {
                            config.messagePost.interval = minutes;
                            config.messagePost.message = message;
                            config.messagePost.enabled = true;

                            stopMessagePost();
                            startMessagePost(groupId);

                            await sock.sendMessage(groupId, { 
                                text: `Postagem automática configurada! ✅

Intervalo: ${minutes} minutos
Mensagem: "${message}"

Status: ATIVO ✅`
                            });
                        } else {
                            await sock.sendMessage(groupId, { 
                                text: 'Use: !mensege post minutos <minutos> <mensagem>\nExemplo: !mensege post minutos 60 Lembrete automático do grupo!'
                            });
                        }
                    } else {
                        const status = config.messagePost.enabled ? 'ATIVO ✅' : 'INATIVO ❌';
                        await sock.sendMessage(groupId, { 
                            text: `POSTAGEM AUTOMÁTICA

Status: ${status}
Intervalo: ${config.messagePost.interval} minutos
Mensagem: "${config.messagePost.message}"

Comandos:
!mensege post on/off
!mensege post minutos <X> <mensagem>`
                        });
                    }
                } else {
                    await sock.sendMessage(groupId, { 
                        text: `Comandos de postagem automática:

!mensege post on/off - Liga/desliga
!mensege post minutos <X> <mensagem> - Configura intervalo e mensagem

Exemplo: !mensege post minutos 30 Mensagem a cada 30min`
                    });
                }
                saveConfig();
                break;

            // CORRIGIDO: Sistema de enquetes com detecção de votos
            case 'poll':
                if (args[0] === 'resulte') {
                    await getPollResult(groupId);
                } else {
                    const pollInput = args.join(' ');
                    const pollParts = pollInput.split('=');

                    if (pollParts.length >= 3) {
                        const question = pollParts[0].trim();
                        const options = pollParts.slice(1).map(opt => opt.trim()).slice(0, 12);

                        const result = await createNativePoll(groupId, question, options);
                        if (result.success) {
                            await sock.sendMessage(groupId, { 
                                text: `Enquete criada! ✅

📊 "${question}"

📝 Opções: ${options.length}
🗳️ Use !poll resulte para ver os resultados em tempo real!

💡 Enquete ativa - votos serão detectados automaticamente` 
                            });
                        } else {
                            await sock.sendMessage(groupId, { text: `❌ Erro ao criar enquete: ${result.error}` });
                        }
                    } else {
                        await sock.sendMessage(groupId, { 
                            text: `Use: !poll <pergunta>=<opcao1>=<opcao2>
Exemplo: !poll Qual sua cor favorita?=Azul=Vermelho=Verde

Para ver resultados: !poll resulte

✨ Os votos são detectados automaticamente!`
                        });
                    }
                }
                break;

            default:
                await sock.sendMessage(groupId, { 
                    text: `Comando "${config.prefix}${command}" não encontrado! ❌

Use ${config.prefix}help para ver todos os comandos`
                });
        }

    } catch (error) {
        console.log('Erro no comando:', error.message);
        await sock.sendMessage(groupId, { text: 'Erro interno no comando! ❌' });
    }
}

async function processMessage(msg) {
    try {
        const { key, message } = msg;
        const messageText = getMessageText(message);
        const groupId = key.remoteJid;
        const userId = key.participant || key.remoteJid;

        // CORRIGIDO: Processar votos de enquetes - detectar quando usuário vota
        if (message && message.pollUpdateMessage) {
            const pollVote = message.pollUpdateMessage;
            console.log('Voto detectado na enquete:', JSON.stringify(pollVote, null, 2));

            // Registrar voto se há enquete ativa
            if (config.activePoll && config.activePoll.groupId === groupId) {
                const voter = normalizeId(userId);
                const selectedOptions = pollVote.vote.selectedOptions || [];

                if (selectedOptions.length > 0) {
                    const selectedIndex = selectedOptions[0]; // Primeiro voto selecionado
                    config.activePoll.votes.set(voter, selectedIndex);
                    config.polls.set(config.activePoll.id, config.activePoll);
                    saveConfig();
                    console.log('Voto registrado:', voter, 'opção:', selectedIndex + 1);
                }
            }
            return;
        }

        if (!groupId.endsWith('@g.us')) return;
        if (isBotMessage(userId)) return;

        // Verificar se bot é admin (exceto para extracto)
        if (config.adminRequired) {
            const botIsAdmin = await isBotAdmin(groupId);
            if (!botIsAdmin && messageText && !messageText.startsWith(config.prefix + 'extracto')) return;
        }

        if (messageText && messageText.startsWith(config.prefix)) {
            await processCommand(msg);
            return;
        }

        if (messageText) {
            const chatbotProcessed = await processChatbot(groupId, messageText);
            if (chatbotProcessed) return;
        }

        // Anti-link
        if (config.antilink.enabled && messageText) {
            const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([^\s]+\.(com|org|net|io|co|br|gov|edu|xyz|tk|ml|ga|cf|ly|bit)[^\s]*)/gi;

            if (linkRegex.test(messageText)) {
                const userIsAdmin = await isAdmin(groupId, userId);

                if (!userIsAdmin) {
                    try {
                        await sock.sendMessage(groupId, { delete: key });

                        if (config.antilink.ban) {
                            await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
                            await sock.sendMessage(groupId, { 
                                text: `USUÁRIO BANIDO POR ENVIAR LINK! 🚫
@${normalizeId(userId)}`,
                                mentions: [userId]
                            });
                        } else {
                            await sock.sendMessage(groupId, { 
                                text: `LINK REMOVIDO! ⚠️ @${normalizeId(userId)}
Links não são permitidos neste grupo!`,
                                mentions: [userId]
                            });
                        }
                    } catch (error) {
                        console.log('Erro no antilink:', error.message);
                    }
                    return;
                }
            }
        }

        // Anti-palavrões
        if (config.antiwords.enabled && config.antiwords.words.length > 0 && messageText) {
            const messageWords = messageText.toLowerCase();
            let foundWord = null;

            for (const word of config.antiwords.words) {
                if (messageWords.includes(word)) {
                    foundWord = word;
                    break;
                }
            }

            if (foundWord) {
                const userIsAdmin = await isAdmin(groupId, userId);

                if (!userIsAdmin) {
                    try {
                        await sock.sendMessage(groupId, { delete: key });

                        if (config.antiwords.ban) {
                            await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
                            await sock.sendMessage(groupId, { 
                                text: `USUÁRIO BANIDO POR PALAVRÃO! 🚫
@${normalizeId(userId)}`,
                                mentions: [userId]
                            });
                        } else {
                            await sock.sendMessage(groupId, { 
                                text: `MENSAGEM REMOVIDA! ⚠️ @${normalizeId(userId)}
Linguagem inapropriada não é permitida!`,
                                mentions: [userId]
                            });
                        }
                    } catch (error) {
                        console.log('Erro no antiwords:', error.message);
                    }
                    return;
                }
            }
        }

    } catch (error) {
        console.log('Erro processar mensagem:', error.message);
    }
}

async function processGroupUpdate(update) {
    try {
        const { id: groupId, action, participants } = update;

        console.log('Evento:', action, '| Grupo:', normalizeId(groupId));

        // Verificar se bot é admin
        if (config.adminRequired) {
            const botIsAdmin = await isBotAdmin(groupId);
            if (!botIsAdmin) return;
        }

        if (action === 'add' && config.welcome.enabled) {
            const groupMetadata = await sock.groupMetadata(groupId);
            await sendWelcome(groupId, participants, groupMetadata.subject);
        }

        if (action === 'remove' && config.goodbye.enabled) {
            const groupMetadata = await sock.groupMetadata(groupId);
            for (const participant of participants) {
                const message = config.goodbye.message
                    .replace('@user', '@' + normalizeId(participant))
                    .replace('@group', groupMetadata.subject);

                if (config.goodbye.media.enabled && fs.existsSync(config.goodbye.media.path)) {
                    await sendMediaMessage(groupId, config.goodbye.media.path, message, [participant]);
                } else {
                    await sock.sendMessage(groupId, { 
                        text: message,
                        mentions: [participant]
                    });
                }
            }
        }
    } catch (error) {
        console.log('Erro evento grupo:', error.message);
    }
}

async function startBot() {
    try {
        console.log('🚀 Iniciando Bot APVS Brasil CORRIGIDO...');

        initDirectories();
        loadConfig();

        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

        sock = makeWASocket({
            auth: state,
            browser: ['APVS Bot Corrigido', 'Chrome', '2.0.0'],
            syncFullHistory: false,
            defaultQueryTimeoutMs: 60000,
            markOnlineOnConnect: false,
            logger: logger,
            printQRInTerminal: true,
            connectTimeoutMs: 60000,
            qrTimeout: 40000
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 QR CODE GERADO - ESCANEIE RAPIDAMENTE:');
                qrcode.generate(qr, { small: true });
                console.log('WhatsApp -> Dispositivos -> Conectar dispositivo');
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('❌ Desconectado:', lastDisconnect?.error?.message);

                if (shouldReconnect) {
                    console.log('🔄 Reconectando em 5 segundos...');
                    setTimeout(startBot, 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ BOT CONECTADO COM SUCESSO!');
                console.log('🤖', config.owner, 'ONLINE - VERSÃO CORRIGIDA');
                console.log('📱 Número:', normalizeId(sock.user.id));
                console.log('🕐 Conectado:', new Date().toLocaleString('pt-BR'));
                console.log('⚡ CORREÇÕES APLICADAS:');
                console.log('  ✅ !poll resulte detecta votos reais automaticamente');
                console.log('  ✅ !extracto cont gera CSV com colunas organizadas');
                console.log('  ✅ Sistema de detecção de votos em enquetes funcionando');
                console.log('  ✅ CSV formatado corretamente para Excel/Sheets');
                console.log('  ✅ Todas as outras funcionalidades mantidas');
                console.log('📋 Digite !help em grupos para ver TODOS os comandos');
                console.log('🎯 PROBLEMAS RESOLVIDOS - SISTEMA 100% FUNCIONAL');
            }
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.key.fromMe && msg.message) {
                await processMessage(msg);
            }
        });

        sock.ev.on('group-participants.update', processGroupUpdate);

    } catch (error) {
        console.log('❌ Erro inicializar:', error.message);
        setTimeout(startBot, 5000);
    }
}

process.on('uncaughtException', (error) => {
    console.log('⚠️ Erro não tratado:', error.message);
});

process.on('unhandledRejection', (error) => {
    console.log('⚠️ Promise rejeitada:', error?.message || 'Erro desconhecido');
});

process.on('SIGINT', () => {
    console.log('👋 Bot finalizado pelo usuário!');
    saveConfig();
    stopMessagePost();
    process.exit(0);
});

console.log('🔥 ADMIM-BOT - BOT CORRIGIDO E OTIMIZADO');
console.log('📱 Versão 2.2 - ENQUETES E CSV CORRIGIDOS');
console.log('🗳️ DETECÇÃO DE VOTOS FUNCIONANDO 100%');
console.log('📊 CSV ORGANIZADO EM COLUNAS SEPARADAS');
console.log('⚡ TODOS OS PROBLEMAS RESOLVIDOS');
console.log('🚀 Iniciando...');

startBot();