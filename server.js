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
const supabaseClient = supabase.createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_API_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

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
// Função para enviar notificação de aprovação via WhatsApp
async function sendPropertyApprovalWhatsApp(brokerEmail, propertyDetails, baseUrl) {
    if (!brokerEmail || !propertyDetails || !baseUrl) {
        throw new Error('Parâmetros obrigatórios não fornecidos');
    }

    // Buscar o número do WhatsApp usando o email do corretor
    const { data: brokerContact, error: contactError } = await supabaseClient
        .from('broker_contacts')
        .select('whatsapp_numbers')
        .eq('broker_email', brokerEmail)
        .single();

    if (contactError || !brokerContact?.whatsapp_numbers) {
        console.error('Erro ao buscar contato do corretor:', contactError);
        throw new Error('Número de WhatsApp não encontrado para este corretor');
    }

    // Função para formatar valores monetários
    const formatCurrency = (value) => {
        return new Intl.NumberFormat('pt-AO', {
            style: 'currency',
            currency: 'AOA'
        }).format(value);
    };

    // Criar o slug a partir do endereço (função auxiliar)
    const createSlug = (address) => {
        return address
            ?.toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '') // Remove acentos
            .replace(/[^\w\s-]/g, '') // Remove caracteres especiais
            .replace(/\s+/g, '-') // Substitui espaços por hífens
            .replace(/-+/g, '-') // Remove hífens duplicados
            .trim() // Remove espaços no início e fim
            || 'endereco-nao-informado';
    };

    const propertySlug = createSlug(propertyDetails.address);
    const propertyLink = `${baseUrl}/view-listing/${propertyDetails.id}/${propertySlug}`;

    const message = `
🏠 *Parabéns! Seu imóvel foi aprovado*

Seu imóvel localizado em *${propertyDetails.address}* foi aprovado e já está disponível em nossa plataforma.

*Detalhes do imóvel:*
📍 Tipo: ${propertyDetails.propertyType || 'Não informado'}
🛏️ Quartos: ${propertyDetails.bedroom || 0}
🚿 Banheiros: ${propertyDetails.bathroom || 0}
💰 Preço: ${formatCurrency(propertyDetails.price || 0)}

Visualize seu imóvel aqui: ${propertyLink}

Se precisar de alguma alteração ou tiver dúvidas, entre em contato conosco.

Atenciosamente,
Equipe Plata Imobiliária
    `.trim();

    try {
        // Validar e formatar o número do WhatsApp
        const whatsappNumber = brokerContact.whatsapp_numbers.replace(/\D/g, '');
        if (!whatsappNumber) {
            throw new Error('Número de WhatsApp inválido');
        }

        const response = await twilioClient.messages.create({
            body: message,
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: `whatsapp:${whatsappNumber}`
        });

        console.log(`Notificação de aprovação enviada via WhatsApp para ${whatsappNumber}, SID: ${response.sid}`);
        return response;
    } catch (error) {
        console.error(`Erro ao enviar notificação WhatsApp:`, error);
        throw error;
    }
}

// Atualizar a rota de aprovação para incluir a notificação WhatsApp
app.patch('/api/properties/:listingId/approve', async (req, res) => {
    try {
        const { listingId } = req.params;

        if (!listingId) {
            return res.status(400).json({
                success: false,
                message: 'ID do imóvel é obrigatório'
            });
        }

        // Buscar detalhes completos do imóvel
        const { data: listing, error: fetchError } = await supabaseClient
            .from('listing')
            .select('*')
            .eq('id', listingId)
            .single();

        if (fetchError || !listing) {
            console.error('Erro ao buscar imóvel:', fetchError);
            return res.status(404).json({
                success: false,
                message: 'Imóvel não encontrado'
            });
        }

        // Verifica se o imóvel já está aprovado
        if (listing.active) {
            return res.status(400).json({
                success: false,
                message: 'Imóvel já está aprovado'
            });
        }

        // Atualiza o status do imóvel para ativo
        const { data: updatedListing, error: updateError } = await supabaseClient
            .from('listing')
            .update({ 
                active: true,
                approved_at: new Date().toISOString()
            })
            .eq('id', listingId)
            .select()
            .single();

        if (updateError) {
            console.error('Erro ao atualizar o imóvel:', updateError);
            return res.status(500).json({
                success: false,
                message: 'Erro ao aprovar o imóvel',
                error: updateError.message
            });
        }

        // Enviar notificação WhatsApp usando o email do listing
        let whatsappNotificationSent = false;
        if (listing.email) {
            try {
                await sendPropertyApprovalWhatsApp(
                    listing.email,
                    listing,
                    process.env.BASE_URL
                );
                whatsappNotificationSent = true;
            } catch (whatsappError) {
                console.error('Erro ao enviar notificação WhatsApp:', whatsappError);
                // Não interrompe o fluxo se a notificação falhar
            }
        }

        // Retorna o imóvel atualizado como resposta
        return res.status(200).json({
            success: true,
            message: 'Imóvel aprovado com sucesso',
            whatsappNotificationSent,
            listing: updatedListing
        });

    } catch (error) {
        console.error('Erro no servidor:', error);
        return res.status(500).json({
            success: false,
            message: 'Erro interno do servidor',
            error: error.message
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


// Iniciar o monitoramento contínuo
monitorVisits();


app.listen(port, () => {
    console.log(`Executando em http://localhost:${port}`);
});
