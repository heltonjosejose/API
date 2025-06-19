const express = require('express');
const dotenv = require('dotenv');
const mg = require('mailgun-js');
const cors = require('cors');
const retry = require('retry');
const supabase = require('@supabase/supabase-js');
const twilio = require('twilio');

dotenv.config();

const app = express();
const port = 3005;

// Configurar Mailgun
const mailgun = mg({
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.MAILGUN_DOMAIN
});

// Configurar Twilio
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Configurar Supabase
const supabaseClient = supabase.createClient(
    process.env.SUPABASE_URL || 'http://62.171.131.151:8000',
    process.env.SUPABASE_SERVICE_ROLE_KEY,  // Usando diretamente a service role key como anon key
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Adicionar no início do arquivo, após as importações
const emailNotificationCache = new Map(); // Para armazenar a última data de envio por corretor

// Dentro da função monitorPropertyAvailability, antes do loop de listingsToCheck
const EMAIL_NOTIFICATION_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 dias em milissegundos

// Função para enviar notificação via WhatsApp
async function sendWhatsAppNotification(userPhone, listing) {
    const message = `
🏠 Novo Imóvel Correspondente às Suas Preferências

Detalhes do imóvel:
- Tipo: ${listing.propertyType}
- Quartos: ${listing.bedroom}
- Mobiliado: ${listing.furnished ? 'Sim' : 'Não'}
- Tipo de Pagamento: ${listing.paymentType}
- Preço: AOA ${listing.price.toFixed(2)}

Para mais detalhes, acesse nossa plataforma.

Atenciosamente,
Equipe Plata Imobiliária
    `;

    try {
        const response = await twilioClient.messages.create({
            body: message,
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: `whatsapp:${userPhone}`
        });
        console.log(`Notificação WhatsApp enviada para ${userPhone}, SID: ${response.sid}`);
        return response;
    } catch (error) {
        console.error(`Erro ao enviar notificação WhatsApp para ${userPhone}:`, error);
        throw error;
    }
}

// Função atualizada para verificar a listagem contra as preferências dos usuários
async function checkListingAgainstPreferences(listing) {
    const { data: userPreferences, error } = await supabaseClient
        .from('searches')
        .select('*');

    if (error) {
        console.error('Erro ao buscar preferências:', error);
        return;
    }

    console.log('Preferências dos usuários:', userPreferences);

    for (const userPreference of userPreferences) {
        const isTypeMatch = 
            userPreference.propertyType === listing.propertyType || 
            (userPreference.propertyType === "Apartamento" && listing.propertyType === "Cobertura") ||
            (userPreference.propertyType === "Casa" && listing.propertyType === "Sobrado");
        const isBedroomMatch = 
            userPreference.bedroom === listing.bedroom || 
            (userPreference.bedroom && Math.abs(userPreference.bedroom - listing.bedroom) <= 1);
        const isFurnishedMatch = 
            userPreference.furnished === listing.furnished || 
            userPreference.furnished === null;
        const isPaymentTypeMatch = 
            userPreference.paymentType === "Qualquer" || 
            userPreference.paymentType === listing.paymentType;
        const isPriceMatch = 
            listing.price >= userPreference.minPrice && 
            listing.price <= userPreference.maxPrice;

        const match = isTypeMatch && isBedroomMatch && isFurnishedMatch && isPaymentTypeMatch && isPriceMatch;

        if (match) {
            // Enviar notificações em paralelo
            await Promise.all([
                sendEmailNotification(userPreference.user_email, listing),
                // Verificar se o usuário tem número de telefone cadastrado
                userPreference.user_phone ? 
                    sendWhatsAppNotification(userPreference.user_phone, listing) : 
                    Promise.resolve()
            ]);
        }
    }
}

  
  
  // Função para enviar notificação por email
  async function sendEmailNotification(userEmail, listing) {
    const message = `
      <h1>Novo Imóvel Correspondente às Suas Preferências</h1>
      <p>Olá,</p>
      <p>Um novo imóvel que corresponde às suas preferências de busca foi anunciado:</p>
      <ul>
        <li><strong>Tipo:</strong> ${listing.propertyType}</li>
        <li><strong>Quartos:</strong> ${listing.bedroom}</li>
        <li><strong>Mobiliado:</strong> ${listing.furnished ? 'Sim' : 'Não'}</li>
        <li><strong>Tipo de Pagamento:</strong> ${listing.paymentType}</li>
        <li><strong>Preço:</strong> R$ ${listing.price.toFixed(2)}</li>
      </ul>
      <p>Para mais detalhes, acesse nossa plataforma.</p>
      <p>Atenciosamente,<br>Equipe Plata Imobiliária</p>
    `;
  
    const emailInfo = {
      from: '"Plata" <plataimobiliaria@gmail.com>',
      to: userEmail,
      subject: 'Novo Imóvel Correspondente às Suas Preferências',
      html: message
    };
  
    try {
      await sendEmail(emailInfo);
      console.log(`Notificação enviada para ${userEmail}`);
    } catch (error) {
      console.error(`Erro ao enviar notificação para ${userEmail}:`, error);
    }
  }
  
  // Nova rota para receber dados de nova listagem e verificar correspondências
  app.post('/api/listing/notify', async (req, res) => {
    const newListing = req.body;
  
    if (!newListing || !newListing.id) {
      return res.status(400).json({ error: 'Dados da listagem inválidos ou incompletos.' });
    }
  
    try {
      await checkListingAgainstPreferences(newListing);
      res.status(200).json({ message: 'Verificação de correspondências concluída.' });
    } catch (error) {
      console.error('Erro ao processar notificação de nova listagem:', error);
      res.status(500).json({ error: 'Erro ao processar notificação de nova listagem.' });
    }
  });

const sendEmail = async (emailInfo) => {
    return new Promise((resolve, reject) => {
        const operation = retry.operation({
            retries: 5, // número de tentativas
            factor: 2, // fator de crescimento exponencial
            minTimeout: 1000, // tempo mínimo entre tentativas
            maxTimeout: 60000, // tempo máximo entre tentativas
        });

        operation.attempt(async (currentAttempt) => {
            try {
                mailgun.messages().send(emailInfo, (error, body) => {
                    if (operation.retry(error)) {
                        console.log(`Tentativa ${currentAttempt} falhou, tentando novamente...`);
                        return;
                    }
                    if (error) {
                        console.error('Erro ao enviar email:', error);
                        reject(operation.mainError());
                    } else {
                        console.log('Email enviado com sucesso:', body);
                        resolve(body);
                    }
                });
            } catch (error) {
                if (!operation.retry(error)) {
                    console.error('Erro ao enviar email após múltiplas tentativas:', error);
                    reject(error);
                }
            }
        });
    });
};

// Endpoint temporário para testar a função monitorVisits
app.get('/api/test-monitor', async (req, res) => {
    try {
        await monitorVisits();
        res.send('Monitoramento de visitas executado com sucesso.');
    } catch (err) {
        console.error('Erro ao executar o monitoramento de visitas:', err);
        res.status(500).send('Erro ao executar o monitoramento de visitas.');
    }
});

app.post('/api/email', async (req, res) => {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
        return res.status(400).send({ message: 'Todos os campos são obrigatórios' });
    }

    const recipients = Array.isArray(to) ? to : [to]; // Suporta envio para múltiplos destinatários

    const emailInfo = recipients.map((recipient) => ({
        from: '"Plata" <plataimobiliaria@gmail.com>',
        to: recipient,
        subject: subject,
        html: message
    }));

    // Importação dinâmica do p-limit
    const { default: pLimit } = await import('p-limit');
    const limit = pLimit(10); // Limitar a 10 requisições simultâneas (ajuste conforme necessário)
    const sendEmailTasks = emailInfo.map((info) => limit(() => sendEmail(info)));

    try {
        const results = await Promise.all(sendEmailTasks);
        res.send({ message: 'Emails enviados', results });
    } catch (error) {
        console.error('Erro ao enviar emails:', error);
        res.status(500).send({ message: 'Algo correu mal ao enviar os emails' });
    }
});

app.get('/api/close-negotiation/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.query;

    try {
        const { error } = await supabaseClient
            .from('schedules')
            .update({ negotiation_status: status })
            .eq('id', id);

        if (error) {
            console.error('Erro ao fechar a negociação:', error);
            res.status(500).send('Erro ao fechar a negociação.');
        } else {
            res.redirect(`${process.env.FRONTEND_URL}/thank-you`);
        }
    } catch (err) {
        console.error('Erro ao processar o fechamento da negociação:', err);
        res.status(500).send('Erro ao processar o fechamento da negociação.');
    }
});

const monitorVisits = async () => {
    console.log('Monitorando visitas e enviando notificações de acompanhamento...');

    try {
        const { data: schedules, error } = await supabaseClient
            .from('schedules')
            .select('id, user_email, user_name, date, negotiation_status, user_phone')
            .lt('date', new Date().toISOString())
            .eq('negotiation_status', 'open');

        if (error) {
            console.error('Erro ao obter agendamentos passados:', error);
            return;
        }

        for (const schedule of schedules) {
            const { id, user_email, user_name, date, user_phone } = schedule;
            const visitDate = new Date(date);
            const closeNegotiationUrl = `${process.env.BASE_URL}/api/close-negotiation/${id}`;

            // Enviar email
            const emailMessage = `
                <p>Olá ${user_name},</p>
                <p>Você teve uma visita agendada no dia ${visitDate.toLocaleDateString()}. Gostaríamos de saber como foi a visita e qual é o estado atual da negociação do imóvel.</p>
                <p>Para nos ajudar a fornecer o melhor suporte possível, por favor, selecione uma das opções abaixo que melhor descreve a situação:</p>

                <p style="text-align: center;">
                    <a href="${closeNegotiationUrl}&status=closed" style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.1); font-size: 16px; margin-bottom: 10px;">✔️ Fechei a Negociação</a>
                    <br><br>
                    <a href="${closeNegotiationUrl}&status=negotiating" style="display: inline-block; padding: 12px 24px; background-color: #FF9800; color: white; text-decoration: none; border-radius: 5px; box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.1); font-size: 16px; margin-bottom: 10px;">💬 Ainda Estou Negociando</a>
                    <br><br>
                    <a href="${closeNegotiationUrl}&status=unavailable" style="display: inline-block; padding: 12px 24px; background-color: #F44336; color: white; text-decoration: none; border-radius: 5px; box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.1); font-size: 16px; margin-bottom: 10px;">🚫 Imóvel Não Está Mais Disponível</a>
                    <br><br>
                    <a href="${closeNegotiationUrl}&status=disliked" style="display: inline-block; padding: 12px 24px; background-color: #9E9E9E; color: white; text-decoration: none; border-radius: 5px; box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.1); font-size: 16px;">👎 Não Gostei do Imóvel</a>
                </p>

                <p>Seu feedback é muito importante para nós. Caso tenha alguma dúvida ou precise de mais informações, não hesite em entrar em contato.</p>

                <p>Atenciosamente,</p>
                <p>Equipe Plata Imobiliária</p>
            `;

            // Enviar WhatsApp
            const whatsappMessage = `
Olá ${user_name},

Você teve uma visita agendada no dia ${visitDate.toLocaleDateString()}. Gostaríamos de saber como foi a visita e qual é o estado atual da negociação do imóvel.

Para nos ajudar, por favor, acesse o link abaixo e selecione a opção que melhor descreve a situação:
${process.env.BASE_URL}/feedback/${id}

Seu feedback é muito importante para nós. 

Atenciosamente,
Equipe Plata Imobiliária
            `;

            // Enviar notificações em paralelo
            await Promise.all([
                sendEmail({
                    from: '"Plata" <plataimobiliaria@gmail.com>',
                    to: user_email,
                    subject: 'Acompanhamento da visita ao imóvel',
                    html: emailMessage,
                }),
                user_phone ? 
                    twilioClient.messages.create({
                        body: whatsappMessage,
                        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
                        to: `whatsapp:${user_phone}`
                    }) : 
                    Promise.resolve()
            ]);

            console.log(`Notificações de acompanhamento enviadas para ${user_email}`);
        }
    } catch (err) {
        console.error('Erro ao monitorar visitas:', err);
    } finally {
        console.log('Tempo esgotando, aguardando 24 horas para próxima execução...');
        setTimeout(monitorVisits, 24 * 60 * 60 * 1000);
    }
};

// Rota para listar imóveis pendentes de aprovação jj
app.get('/api/properties/pending', async (req, res) => {
    try {
        // Query no Supabase para pegar os imóveis com active = false
        const { data, error } = await supabaseClient
            .from('listing')
            .select('*, listingImages(url, listing_id)')
            .eq('active', false) // Removeu o filtro por 'id'
                        
        if (error) {
            console.error('Erro ao buscar imóveis pendentes de aprovação:', error);
            return res.status(500).send({ message: 'Erro ao buscar imóveis pendentes de aprovação.' });
        }

        // Enviar a lista de imóveis pendentes como resposta
        res.send({ properties: data });
    } catch (err) {
        console.error('Erro ao processar a requisição:', err);
        res.status(500).send({ message: 'Erro ao processar a requisição.' });
    }
});
// Função auxiliar para formatar valor monetário
function formatCurrency(value) {
    return new Intl.NumberFormat('pt-AO', {
        style: 'currency',
        currency: 'AOA'
    }).format(value || 0);
}

// Função melhorada para enviar notificação WhatsApp
async function sendPropertyApprovalWhatsApp(brokerEmail, propertyDetails, baseUrl) {
    try {
        console.log('[DEBUG] Iniciando processo de notificação WhatsApp:', {
            brokerEmail,
            propertyId: propertyDetails.id,
            timestamp: new Date().toISOString()
        });

        // Validações iniciais
        if (!brokerEmail || !propertyDetails || !baseUrl) {
            console.log('[DEBUG] Validação falhou:', {
                brokerEmail: !!brokerEmail,
                propertyDetails: !!propertyDetails,
                baseUrl: !!baseUrl
            });
            throw new Error('Parâmetros obrigatórios não fornecidos');
        }

        // Debug das configurações do Twilio
        console.log('[DEBUG] Verificando configurações Twilio:', {
            hasAccountSid: !!process.env.TWILIO_ACCOUNT_SID,
            hasAuthToken: !!process.env.TWILIO_AUTH_TOKEN,
            hasWhatsAppNumber: !!process.env.TWILIO_WHATSAPP_NUMBER,
            twilioWhatsAppNumber: process.env.TWILIO_WHATSAPP_NUMBER
        });

        // Alternativa usando query SQL
        const { data: brokerContacts, error: contactError } = await supabaseClient
            .from('broker_contacts')
            .select('whatsapp_numbers, broker_email')
            .eq('broker_email', propertyDetails.createdBy);

        if (contactError) {
            console.error(`[DEBUG] Erro ao buscar contato do corretor para imóvel ${propertyDetails.id}:`, contactError);
            throw new Error('Contato do corretor não encontrado');
        }

        const brokerContact = brokerContacts?.[0];
        if (!brokerContact || !brokerContact.whatsapp_numbers) {
            console.log(`[DEBUG] Corretor não encontrado ou sem WhatsApp para imóvel ${propertyDetails.id}. Email: ${propertyDetails.createdBy}`);
            throw new Error('Contato do corretor não encontrado');
        }

        // Gerar o link do imóvel
        console.log('[DEBUG] Gerando slug do imóvel:', {
            address: propertyDetails.address
        });

        const propertySlug = propertyDetails.address
            ?.toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .trim() || 'endereco-nao-informado';

        const propertyLink = `${baseUrl}/view-listing/${propertyDetails.id}/${propertySlug}`;

        console.log('[DEBUG] Link do imóvel gerado:', {
            propertyLink,
            slug: propertySlug
        });

        // Criar a mensagem
        const message = `
🏠 *Novo Imóvel Aprovado!*

Olá,

Seu imóvel localizado em *${propertyDetails.address}* foi aprovado com sucesso e já está disponível em nossa plataforma.

*Detalhes do Imóvel:*
📍 Tipo: ${propertyDetails.propertyType || 'Não informado'}
🛏️ Quartos: ${propertyDetails.bedroom || 0}
🚿 Banheiros: ${propertyDetails.bathroom || 0}
💰 Preço: ${formatCurrency(propertyDetails.price)}

🔍 Visualize seu imóvel aqui: ${propertyLink}

Precisa fazer alguma alteração ou tem dúvidas? Entre em contato conosco!

Atenciosamente,
Equipe Plata Imobiliária
        `.trim();

        console.log('[DEBUG] Mensagem preparada:', {
            messageLength: message.length,
            hasPropertyDetails: {
                address: !!propertyDetails.address,
                type: !!propertyDetails.propertyType,
                bedroom: !!propertyDetails.bedroom,
                bathroom: !!propertyDetails.bathroom,
                price: !!propertyDetails.price
            }
        });

        // Verificar configurações do Twilio
        if (!process.env.TWILIO_ACCOUNT_SID || 
            !process.env.TWILIO_AUTH_TOKEN || 
            !process.env.TWILIO_WHATSAPP_NUMBER) {
            console.error('[DEBUG] Configurações Twilio incompletas:', {
                hasSid: !!process.env.TWILIO_ACCOUNT_SID,
                hasToken: !!process.env.TWILIO_AUTH_TOKEN,
                hasNumber: !!process.env.TWILIO_WHATSAPP_NUMBER
            });
            throw new Error('Configurações do Twilio incompletas');
        }

        // Enviar a mensagem
        console.log('[DEBUG] Preparando envio WhatsApp:', {
            to: brokerContact.whatsapp_numbers,
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            messageLength: message.length
        });
        
        const response = await twilioClient.messages.create({
            body: message,
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: `whatsapp:${brokerContact.whatsapp_numbers}`
        });

        console.log('[DEBUG] Resposta do Twilio:', {
            messageSid: response.sid,
            status: response.status,
            errorCode: response.errorCode,
            errorMessage: response.errorMessage,
            direction: response.direction,
            timestamp: new Date().toISOString()
        });

        return response;

    } catch (error) {
        console.error('[DEBUG] Erro detalhado ao enviar notificação WhatsApp:', {
            error: {
                name: error.name,
                message: error.message,
                code: error.code,
                status: error.status,
                details: error.details,
                stack: error.stack
            },
            brokerEmail,
            propertyId: propertyDetails.id,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

// Rota de aprovação atualizada
app.patch('/api/properties/:listingId/approve', async (req, res) => {
    try {
        const { listingId } = req.params;
        console.log('[DEBUG] Iniciando processo de aprovação:', {
            listingId,
            timestamp: new Date().toISOString()
        });

        if (!listingId) {
            console.log('[DEBUG] ID do imóvel não fornecido');
            return res.status(400).json({
                success: false,
                message: 'ID do imóvel é obrigatório'
            });
        }

        // Buscar detalhes do imóvel
        console.log('[DEBUG] Buscando detalhes do imóvel:', { listingId });
        const { data: listings, error: fetchError } = await supabaseClient
            .from('listing')
            .select('*, createdBy')
            .eq('id', listingId);

        const listing = listings?.[0];

        console.log('[DEBUG] Resultado da busca do imóvel:', {
            found: !!listing,
            hasError: !!fetchError,
            createdBy: listing?.createdBy,
            active: listing?.active,
            totalFound: listings?.length
        });

        if (fetchError) {
            console.error('[DEBUG] Erro ao buscar imóvel:', {
                error: fetchError,
                listingId
            });
            return res.status(500).json({
                success: false,
                message: 'Erro ao buscar imóvel',
                error: fetchError.message
            });
        }

        if (!listing) {
            console.log('[DEBUG] Imóvel não encontrado:', { listingId });
            return res.status(404).json({
                success: false,
                message: 'Imóvel não encontrado'
            });
        }

        // Verificar se já está aprovado
        if (listing.active) {
            console.log('[DEBUG] Imóvel já aprovado:', { listingId });
            return res.status(400).json({
                success: false,
                message: 'Imóvel já está aprovado'
            });
        }

        // Aprovar o imóvel
        console.log('[DEBUG] Atualizando status do imóvel:', { 
            listingId,
            body: req.body 
        });

        // Primeiro, vamos verificar se o registro ainda existe e está acessível
        const { data: checkListing, error: checkError } = await supabaseClient
            .from('listing')
            .select('*')
            .eq('id', listingId)
            .maybeSingle();

        console.log('[DEBUG] Verificação de acesso:', {
            found: !!checkListing,
            hasError: !!checkError,
            error: checkError,
            data: checkListing
        });

        if (checkError) {
            console.error('[DEBUG] Erro ao verificar acesso ao imóvel:', {
                error: checkError,
                listingId
            });
            return res.status(500).json({
                success: false,
                message: 'Erro ao verificar acesso ao imóvel',
                error: checkError.message
            });
        }

        if (!checkListing) {
            console.error('[DEBUG] Imóvel não encontrado ou sem permissão de acesso:', { listingId });
            return res.status(404).json({
                success: false,
                message: 'Imóvel não encontrado ou sem permissão de acesso'
            });
        }

        // Agora tenta a atualização
        const { data: updatedListing, error: updateError } = await supabaseClient
            .from('listing')
            .update({
                active: true,
                approved_at: new Date().toISOString()
            })
            .eq('id', listingId)
            .select('*')
            .single();

        console.log('[DEBUG] Resultado da atualização:', {
            success: !!updatedListing,
            hasError: !!updateError,
            error: updateError,
            data: updatedListing
        });

        if (updateError) {
            console.error('[DEBUG] Erro ao atualizar imóvel:', {
                error: updateError,
                listingId
            });
            return res.status(500).json({
                success: false,
                message: 'Erro ao atualizar imóvel',
                error: updateError.message
            });
        }

        if (!updatedListing) {
            console.error('[DEBUG] Imóvel não foi atualizado:', { listingId });
            return res.status(500).json({
                success: false,
                message: 'Imóvel não foi atualizado'
            });
        }

        // Se chegou aqui, a atualização foi bem sucedida
        console.log('[DEBUG] Imóvel atualizado com sucesso:', {
            listingId,
            updatedListing
        });

        // Tentar enviar notificação WhatsApp, mas não falhar se não conseguir
        let whatsappNotificationSent = false;
        let whatsappError = null;

        if (listing.createdBy) {
            console.log('[DEBUG] Tentando enviar notificação WhatsApp:', {
                createdBy: listing.createdBy,
                listingId
            });
            try {
                await sendPropertyApprovalWhatsApp(
                    listing.createdBy,
                    listing,
                    process.env.BASE_URL || 'https://plata.ao'
                );
                whatsappNotificationSent = true;
                console.log('[DEBUG] Notificação WhatsApp enviada com sucesso');
            } catch (error) {
                console.error('[DEBUG] Erro ao enviar notificação WhatsApp:', {
                    error: error.message,
                    stack: error.stack,
                    createdBy: listing.createdBy,
                    listingId
                });
                whatsappError = error.message;
                // Não falhar se o WhatsApp falhar
            }
        }

        // Retornar resposta de sucesso mesmo se o WhatsApp falhar
        console.log('[DEBUG] Finalizando processo de aprovação:', {
            listingId,
            whatsappNotificationSent,
            hasError: !!whatsappError
        });

        return res.status(200).json({
            success: true,
            message: 'Imóvel aprovado com sucesso',
            whatsappNotificationSent,
            whatsappError,
            updatedListing: updatedListing
        });

    } catch (error) {
        console.error('[DEBUG] Erro no servidor:', {
            error: {
                message: error.message,
                stack: error.stack
            },
            listingId: req.params.listingId,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({
            success: false,
            message: 'Erro interno do servidor',
            error: error.message
        });
    }
});

// Rota de teste detalhada para WhatsApp
app.post('/api/test-whatsapp', async (req, res) => {
    const { phone } = req.body;
    
    // Log inicial
    console.log('Iniciando teste de envio de WhatsApp:', {
        receivedPhone: phone,
        twilioConfig: {
            accountSidExists: !!process.env.TWILIO_ACCOUNT_SID,
            authTokenExists: !!process.env.TWILIO_AUTH_TOKEN,
            whatsappNumberExists: !!process.env.TWILIO_WHATSAPP_NUMBER
        }
    });

    // Validação básica
    if (!phone) {
        return res.status(400).json({
            success: false,
            error: 'Número de telefone é obrigatório',
            received: { phone }
        });
    }

    // Formatar o número (garantir que está no formato correto)
    let formattedPhone = phone;
    if (!phone.startsWith('+')) {
        formattedPhone = `+${phone}`;
    }
    
    try {
        // Log antes do envio
        console.log('Tentando enviar mensagem:', {
            to: `whatsapp:${formattedPhone}`,
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        });

        // Tentar enviar a mensagem
        const response = await twilioClient.messages.create({
            body: "🔍 Teste de mensagem do sistema Plata\n\nSe você recebeu esta mensagem, significa que a configuração do WhatsApp está funcionando corretamente!\n\nAtenciosamente,\nEquipe Plata",
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: `whatsapp:${formattedPhone}`
        });
        
        // Log de sucesso
        console.log('Mensagem enviada com sucesso:', {
            messageSid: response.sid,
            status: response.status,
            to: formattedPhone
        });

        // Resposta de sucesso
        res.json({
            success: true,
            messageSid: response.sid,
            status: response.status,
            details: {
                to: formattedPhone,
                from: process.env.TWILIO_WHATSAPP_NUMBER
            }
        });

    } catch (error) {
        // Log de erro detalhado
        console.error('Erro ao enviar mensagem:', {
            error: {
                message: error.message,
                code: error.code,
                status: error.status,
                moreInfo: error.moreInfo,
                details: error.details
            },
            phone: formattedPhone
        });

        // Resposta de erro
        res.status(500).json({
            success: false,
            error: error.message,
            errorCode: error.code,
            details: {
                to: formattedPhone,
                twilioError: error.moreInfo
            }
        });
    }
});
// Endpoint para criar o título
app.post('/api/listing/title', async (req, res) => {
    const { listingId } = req.body;

    try {
        if (!listingId) {
            return res.status(400).json({ error: 'ID da listagem é obrigatório.' });
        }

        console.log(`Buscando listagem com ID: ${listingId}`);

        // Use a instância correta do Supabase: supabaseClient
        const { data: listing, error: fetchError } = await supabaseClient
            .from('listing')
            .select('propertyType, address')
            .eq('id', listingId)
            .single();

        if (fetchError) {
            console.error('Erro ao buscar a listagem:', fetchError);
            return res.status(500).json({ error: 'Erro ao buscar a listagem.' });
        }

        if (!listing) {
            return res.status(404).json({ error: 'Listagem não encontrada.' });
        }

        const title = `${listing.propertyType} em ${listing.address}`;
        console.log('Criando título:', title);

        const { data: updatedData, error: updateError } = await supabaseClient
            .from('listing')
            .update({ title })
            .eq('id', listingId)
            .select();

        if (updateError) {
            console.error('Erro ao atualizar o título:', updateError);
            return res.status(500).json({ error: 'Erro ao atualizar o título.' });
        }

        console.log('Título atualizado com sucesso:', updatedData);

        res.status(200).json({ message: 'Título criado com sucesso!', data: updatedData });
    } catch (error) {
        console.error('Erro ao criar o título:', error.message);
        res.status(500).json({ error: 'Erro ao criar o título.' });
    }
});

// Função para monitorar disponibilidade dos imóveis
async function monitorPropertyAvailability() {
    console.log('[DEBUG] Iniciando monitoramento de disponibilidade dos imóveis');

    try {
        // Buscar imóveis ativos
        const { data: activeListings, error: fetchError } = await supabaseClient
            .from('listing')
            .select(`
                id,
                createdBy,
                address,
                propertyType,
                price,
                created_at,
                last_availability_check,
                type
            `)
            .eq('active', true);

        if (fetchError) {
            console.error('[DEBUG] Erro ao buscar imóveis:', fetchError);
            return;
        }

        const currentDate = new Date();
        const defaultCheckThreshold = 30; // Dias para verificação padrão (venda)
        const urgentCheckThreshold = 2; // Dias para verificação urgente (aluguel em áreas específicas)

        // Função auxiliar para verificar se é uma área de alta rotatividade
        const isHighTurnoverArea = (address) => {
            const highTurnoverKeywords = ['kilamba', 'zango 0', 'urbanização nova vida'];
            return highTurnoverKeywords.some(keyword => 
                address.toLowerCase().includes(keyword.toLowerCase())
            );
        };

        // Filtrar imóveis que precisam de verificação
        const listingsToCheck = activeListings.filter(listing => {
            const lastCheck = listing.last_availability_check 
                ? new Date(listing.last_availability_check) 
                : new Date(listing.created_at);
            
            const daysSinceLastCheck = Math.floor((currentDate - lastCheck) / (1000 * 60 * 60 * 24));
            
            // Determinar o limite de dias com base no tipo e localização
            const isRental = listing.type === 'rent';
            const isHighTurnover = isHighTurnoverArea(listing.address);
            
            const threshold = (isRental && isHighTurnover) 
                ? urgentCheckThreshold 
                : defaultCheckThreshold;
            
            return daysSinceLastCheck >= threshold;
        });

        console.log(`[DEBUG] ${listingsToCheck.length} imóveis precisam de verificação`);

        for (const listing of listingsToCheck) {
            // Alternativa usando query SQL
            const { data: brokerContacts, error: contactError } = await supabaseClient
                .from('broker_contacts')
                .select('whatsapp_numbers, broker_email')
                .eq('broker_email', listing.createdBy);

            if (contactError) {
                console.error(`[DEBUG] Erro ao buscar contato do corretor para imóvel ${listing.id}:`, contactError);
                continue;
            }

            const brokerContact = brokerContacts?.[0];
            if (!brokerContact || !brokerContact.whatsapp_numbers) {
                console.log(`[DEBUG] Corretor não encontrado ou sem WhatsApp para imóvel ${listing.id}. Email: ${listing.createdBy}`);
                
                // Verificar quando foi o último email enviado para este corretor
                const lastNotification = emailNotificationCache.get(listing.createdBy);
                const now = Date.now();
                
                if (!lastNotification || (now - lastNotification) > EMAIL_NOTIFICATION_THRESHOLD) {
                    try {
                        await sendEmail({
                            from: '"Plata Imobiliária" <plataimobiliaria@gmail.com>',
                            to: listing.createdBy,
                            subject: 'Importante: Cadastre seu WhatsApp para receber leads diretos',
                            html: `
                                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                                    <h2 style="color: #2c3e50;">Olá, Corretor!</h2>
                                    
                                    <p>Notamos que você ainda não cadastrou seu número de WhatsApp na plataforma Plata. 
                                    Para receber leads e interagir com clientes diretamente via WhatsApp, siga estes passos:</p>

                                    <ol style="line-height: 1.6;">
                                        <li>Acesse <a href="https://www.plata.ao" style="color: #3498db;">www.plata.ao</a></li>
                                        <li>Faça login na sua conta</li>
                                        <li>Clique na sua foto de perfil no canto superior direito</li>
                                        <li>Selecione "Meu Perfil"</li>
                                        <li>Clique no botão Menu</li>
                                        <li>Escolha a opção "Ferramentas"</li>
                                        <li>Cadastre seu número de WhatsApp</li>
                                    </ol>

                                    <p style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #3498db;">
                                        <strong>Benefícios:</strong><br>
                                        ✓ Receba leads diretamente no seu WhatsApp<br>
                                        ✓ Comunicação mais rápida com clientes interessados<br>
                                        ✓ Aumente suas chances de fechar negócios
                                    </p>

                                    <p>Não perca mais oportunidades de negócio! Cadastre seu WhatsApp agora.</p>

                                    <p style="margin-top: 20px;">
                                        Atenciosamente,<br>
                                        Equipe Plata Imobiliária
                                    </p>
                                </div>
                            `
                        });
                        
                        // Atualizar o cache com a data do envio
                        emailNotificationCache.set(listing.createdBy, now);
                        console.log(`[DEBUG] Email de instrução enviado para: ${listing.createdBy}`);
                    } catch (emailError) {
                        console.error(`[DEBUG] Erro ao enviar email de instrução para: ${listing.createdBy}`, emailError);
                    }
                } else {
                    console.log(`[DEBUG] Email já enviado recentemente para: ${listing.createdBy}. Próximo envio em: ${new Date(lastNotification + EMAIL_NOTIFICATION_THRESHOLD)}`);
                }
                continue;
            }

            // Criar mensagem de verificação com urgência para áreas específicas
            const isHighTurnover = isHighTurnoverArea(listing.address);
            const isRental = listing.type === 'rent';
            const urgencyPrefix = (isRental && isHighTurnover) 
                ? '⚠️ *VERIFICAÇÃO URGENTE*\n\n' 
                : '';

            const message = `
${urgencyPrefix}🏠 *Verificação de Disponibilidade*

Olá! Estamos realizando uma verificação ${isRental && isHighTurnover ? 'urgente' : 'de rotina'}.

*Sobre o imóvel:*
📍 Endereço: ${listing.address}
🏢 Tipo: ${listing.propertyType}
💰 Preço: ${formatCurrency(listing.price)}
📋 Finalidade: ${listing.type === 'rent' ? 'Aluguel' : 'Venda'}

Por favor, confirme se este imóvel ainda está disponível respondendo com:
1️⃣ - Sim, ainda está disponível
2️⃣ - Não, já foi vendido/alugado
3️⃣ - Preciso atualizar informações

${isRental && isHighTurnover ? '⚡ Resposta urgente necessária devido à alta demanda na região!' : 'Sua resposta nos ajuda a manter nossa plataforma atualizada!'}

Atenciosamente,
Equipe Plata Imobiliária
            `.trim();

            try {
                // Enviar mensagem WhatsApp
                await twilioClient.messages.create({
                    body: message,
                    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
                    to: `whatsapp:${brokerContact.whatsapp_numbers}`
                });

                // Atualizar data da última verificação
                await supabaseClient
                    .from('listing')
                    .update({ 
                        last_availability_check: new Date().toISOString()
                    })
                    .eq('id', listing.id);

                console.log(`[DEBUG] Verificação enviada para imóvel ${listing.id}`);
                
                // Aguardar um pouco entre cada envio para evitar limitações de API
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                console.error(`[DEBUG] Erro ao enviar verificação para imóvel ${listing.id}:`, error);
            }
        }

    } catch (error) {
        console.error('[DEBUG] Erro no monitoramento de disponibilidade:', error);
    }

    // Agendar próxima verificação
    console.log('[DEBUG] Agendando próxima verificação em 24 horas');
    setTimeout(monitorPropertyAvailability, 24 * 60 * 60 * 1000);
}

// Webhook para receber respostas do WhatsApp via Twilio
app.post('/api/whatsapp-webhook', async (req, res) => {
    try {
        const { Body, From } = req.body;
        console.log('[DEBUG] Recebida resposta WhatsApp:', { From, Body });

        // Buscar corretor pelo número do WhatsApp
        const whatsappNumber = From.replace('whatsapp:', '');
        const { data: broker, error: brokerError } = await supabaseClient
            .from('broker_contacts')
            .select('broker_email')
            .eq('whatsapp_numbers', whatsappNumber)
            .single();

        if (brokerError || !broker) {
            console.error('[DEBUG] Corretor não encontrado:', brokerError);
            return res.status(404).send('Broker not found');
        }

        // Processar resposta
        const response = Body.trim();
        
        switch (response) {
            case '1':
                // Imóvel ainda disponível - não precisa fazer nada
                break;
            
            case '2':
                // Imóvel vendido/alugado - desativar
                await supabaseClient
                    .from('listing')
                    .update({ 
                        active: false,
                        deactivation_reason: 'sold',
                        deactivated_at: new Date().toISOString()
                    })
                    .eq('createdBy', broker.broker_email)
                    .eq('active', true);
                break;
            
            case '3':
                // Precisa atualizar informações
                // Enviar link para atualização
                const updateMessage = `
🔄 Para atualizar as informações do imóvel, acesse:
${process.env.FRONTEND_URL}

Atenciosamente,
Equipe Plata Imobiliária
                `.trim();

                await twilioClient.messages.create({
                    body: updateMessage,
                    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
                    to: From
                });
                break;
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('[DEBUG] Erro ao processar resposta WhatsApp:', error);
        res.status(500).send('Error processing webhook');
    }
});

// Rota para notificações
app.post('/api/notifications', async (req, res) => {
    try {
        const { type, data } = req.body;

        switch (type) {
            case 'price_reduced':
            case 'status_update': // Para ações como "Arrendado" ou "Vendido"
                // Buscar usuários que visualizaram o imóvel
                const { data: views, error: viewsError } = await supabaseClient
                    .from('property_views')
                    .select('user_email, user_phone')
                    .eq('listing_id', data.listing_id);

                if (viewsError) {
                    console.error('Erro ao buscar visualizações:', viewsError);
                    return res.status(500).json({ error: 'Erro ao buscar visualizações' });
                }

                // Enviar notificações para cada usuário
                await Promise.all(
                    views.map(view => {
                        const emailMessage = `
                            <p>Olá,</p>
                            <p>O imóvel "${data.listing_title}" teve uma atualização:</p>
                            <ul>
                                <li><strong>Ação:</strong> ${type === 'price_reduced' ? 'Redução de Preço' : 'Status Atualizado'}</li>
                                ${type === 'price_reduced' ? `
                                    <li><strong>Preço Antigo:</strong> ${formatCurrency(data.old_price)}</li>
                                    <li><strong>Novo Preço:</strong> ${formatCurrency(data.new_price)}</li>
                                    <li><strong>Desconto:</strong> ${data.discount_percentage}%</li>
                                ` : `
                                    <li><strong>Novo Status:</strong> ${data.status}</li>
                                `}
                            </ul>
                            <p>Para mais detalhes, acesse o link abaixo:</p>
                            <p>
                                <a href="${data.listing_link}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                                    Ver Imóvel
                                </a>
                            </p>
                            <p>Atenciosamente,<br>Equipe Plata</p>
                        `;

                        const whatsappMessage = `
🏠 *Atualização no Imóvel*

Olá!

O imóvel "${data.listing_title}" teve uma atualização:

${type === 'price_reduced' ? `
💰 *Redução de Preço*
- Preço Antigo: ${formatCurrency(data.old_price)}
- Novo Preço: ${formatCurrency(data.new_price)}
- Desconto: ${data.discount_percentage}%
` : `
📋 *Status Atualizado*
- Novo Status: ${data.status}
`}

Para mais detalhes, acesse:
${data.listing_link}

Atenciosamente,
Equipe Plata
                        `.trim();

                        return Promise.all([
                            // Enviar e-mail
                            sendEmail({
                                from: '"Plata" <plataimobiliaria@gmail.com>',
                                to: view.user_email,
                                subject: type === 'price_reduced' ? 'Redução de Preço no Imóvel' : 'Status do Imóvel Atualizado',
                                html: emailMessage,
                            }),
                            // Enviar WhatsApp (se houver número de telefone)
                            view.user_phone ? 
                                twilioClient.messages.create({
                                    body: whatsappMessage,
                                    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
                                    to: `whatsapp:${view.user_phone}`,
                                }) : 
                                Promise.resolve(),
                        ]);
                    })
                );
                break;

            // Casos existentes (visit_approved, visit_rejected, etc.)
            case 'visit_approved':
                // Notificar visitante que a visita foi aprovada
                await Promise.all([
                    sendEmail({
                        from: '"Plata" <plataimobiliaria@gmail.com>',
                        to: data.visitor_email,
                        subject: 'Sua visita foi aprovada!',
                        html: `
                            <p>Olá ${data.visitor_name}!</p>
                            
                            <p>Sua visita ao imóvel ${data.property_title} foi aprovada para o dia ${data.date} às ${data.time}.</p>
                            
                            <p>Aguarde o contato do vistoriador para confirmar os detalhes.</p>
                            
                            <p>Atenciosamente,<br>
                            Equipe Plata</p>
                        `
                    }),
                    // Notificar via WhatsApp se houver número de telefone
                    data.visitor_phone ? 
                        twilioClient.messages.create({
                            body: `Olá ${data.visitor_name}! 
                            
Sua visita ao imóvel ${data.property_title} foi aprovada para ${data.date} às ${data.time}.

Aguarde o contato do vistoriador.`,
                            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
                            to: `whatsapp:${data.visitor_phone}`
                        }) : 
                        Promise.resolve()
                ]);
                break;

            case 'visit_rejected':
                await sendEmail({
                    from: '"Plata" <plataimobiliaria@gmail.com>',
                    to: data.visitor_email,
                    subject: 'Status da sua visita',
                    html: `
                        <p>Olá ${data.visitor_name},</p>
                        
                        <p>Infelizmente sua visita ao imóvel ${data.property_title} não pôde ser aprovada.</p>
                        
                        <p>Você pode tentar agendar em outro horário ou procurar outros imóveis similares.</p>
                        
                        <p>Atenciosamente,<br>
                        Equipe Plata</p>
                    `
                });
                break;

            case 'visit_accompanied':
                await Promise.all([
                    // Notificar visitante
                    sendEmail({
                        from: '"Plata" <plataimobiliaria@gmail.com>',
                        to: data.visitor_email,
                        subject: 'Vistoriador confirmou sua visita',
                        html: `
                            <p>Olá ${data.visitor_name}!</p>
                            
                            <p>O vistoriador ${data.inspector_name} confirmou que irá acompanhar sua visita ao imóvel ${data.property_title} no dia ${data.date} às ${data.time}.</p>
                            
                            <p><strong>Dados do vistoriador:</strong><br>
                            Nome: ${data.inspector_name}</p>
                            
                            <p>Em caso de dúvidas ou necessidade de reagendamento, entre em contato conosco.</p>
                            
                            <p>Atenciosamente,<br>
                            Equipe Plata</p>
                        `
                    }),
                    // Notificar proprietário
                    sendEmail({
                        from: '"Plata" <plataimobiliaria@gmail.com>',
                        to: data.owner_email,
                        subject: 'Visita confirmada',
                        html: `
                            <p>Olá ${data.owner_name}!</p>
                            
                            <p>O vistoriador ${data.inspector_name} confirmou que irá acompanhar a visita do(a) ${data.visitor_name} ao seu imóvel ${data.property_title} no dia ${data.date} às ${data.time}.</p>
                            
                            <p><strong>Dados da visita:</strong><br>
                            Visitante: ${data.visitor_name}<br>
                            Vistoriador: ${data.inspector_name}<br>
                            Data: ${data.date}<br>
                            Hora: ${data.time}</p>
                            
                            <p>Atenciosamente,<br>
                            Equipe Plata</p>
                        `
                    }),
                    // Notificações WhatsApp
                    ...[
                        data.visitor_phone && twilioClient.messages.create({
                            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
                            to: `whatsapp:${data.visitor_phone}`,
                            body: `Olá ${data.visitor_name}! 

O vistoriador ${data.inspector_name} confirmou sua visita ao imóvel ${data.property_title} para ${data.date} às ${data.time}.`
                        }),
                        data.owner_phone && twilioClient.messages.create({
                            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
                            to: `whatsapp:${data.owner_phone}`,
                            body: `Olá ${data.owner_name}! 

O vistoriador ${data.inspector_name} confirmou que irá acompanhar a visita de ${data.visitor_name} ao seu imóvel ${data.property_title} em ${data.date} às ${data.time}.`
                        })
                    ].filter(Boolean)
                ]);
                break;

            case 'visit_rescheduled':
                await sendEmail({
                    from: '"Plata" <plataimobiliaria@gmail.com>',
                    to: [data.owner_email, data.visitor_email],
                    subject: 'Visita reagendada',
                    html: `
                        <p>Olá!</p>
                        
                        <p>A visita ao imóvel ${data.property_title} foi reagendada:</p>
                        
                        <p><strong>Nova data:</strong> ${data.new_date}<br>
                        <strong>Novo horário:</strong> ${data.new_time}</p>
                        
                        <p>Por favor, confirme se o novo horário é adequado.</p>
                        
                        <p>Atenciosamente,<br>
                        Equipe Plata</p>
                    `
                });
                break;

            case 'visit_cancelled':
                await sendEmail({
                    from: '"Plata" <plataimobiliaria@gmail.com>',
                    to: [data.owner_email, data.visitor_email],
                    subject: 'Visita cancelada',
                    html: `
                        <p>Olá!</p>
                        
                        <p>A visita ao imóvel ${data.property_title} foi cancelada.</p>
                        
                        <p>Se desejar, você pode reagendar para outro horário.</p>
                        
                        <p>Atenciosamente,<br>
                        Equipe Plata</p>
                    `
                });
                break;

            default:
                return res.status(400).json({ error: 'Tipo de notificação inválido' });
        }

        res.status(200).json({ message: 'Notificações enviadas com sucesso' });
    } catch (error) {
        console.error('Erro ao enviar notificações:', error);
        res.status(500).json({ error: 'Erro ao enviar notificações' });
    }
});
// Iniciar o monitoramento quando o servidor iniciar
monitorPropertyAvailability();


// Iniciar o monitoramento contínuo
monitorVisits();


app.listen(port, () => {
    console.log(`Executando em http://localhost:${port}`);
});
