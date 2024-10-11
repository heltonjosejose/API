const express = require('express');
const dotenv = require('dotenv');
const mg = require('mailgun-js');
const cors = require('cors');
const retry = require('retry');
const supabase = require('@supabase/supabase-js');

dotenv.config();

const app = express();
const port = 3005;

// Configurar Mailgun
const mailgun = mg({
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.MAILGUN_DOMAIN
});

// Configurar Supabase
const supabaseClient = supabase.createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_API_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

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

// Função para monitorar visitas e enviar e-mails de acompanhamento
const monitorVisits = async () => {
    console.log('Monitorando visitas e enviando e-mails de acompanhamento...');

    try {
        const { data: schedules, error } = await supabaseClient
            .from('schedules')
            .select('id, user_email, user_name, date, negotiation_status')
            .lt('date', new Date().toISOString())
            .eq('negotiation_status', 'open');

        if (error) {
            console.error('Erro ao obter agendamentos passados:', error);
            return;
        }

        for (const schedule of schedules) {
            const { id, user_email, user_name, date } = schedule;
            const visitDate = new Date(date);

            const closeNegotiationUrl = `${process.env.BASE_URL}/api/close-negotiation/${id}`;

            const message = `
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

            await sendEmail({
                from: '"Plata" <plataimobiliaria@gmail.com>',
                to: user_email,
                subject: 'Acompanhamento da visita ao imóvel',
                html: message,
            });

            console.log(`Email de acompanhamento enviado para ${user_email}`);
        }
    } catch (err) {
        console.error('Erro ao monitorar visitas:', err);
    } finally {
        console.log('Tempo esgotando, aguardando 24 horas para próxima execução...');

        setTimeout(monitorVisits, 24 * 60 * 60 * 1000); // 24 horas
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
app.patch('/api/properties/:listingId/approve', async (req, res) => {
    try {
        const { listingId } = req.params;

        if (!listingId) {
            return res.status(400).json({
                message: 'ID do imóvel é obrigatório'
            });
        }

        // Verifica se o imóvel existe
        const { data: existingListing, error: fetchError } = await supabaseClient
            .from('listing')
            .select('id, active')
            .eq('id', listingId)
            .single();

        if (fetchError || !existingListing) {
            console.error('Erro ao buscar imóvel ou imóvel não encontrado:', fetchError);
            return res.status(404).json({
                message: 'Imóvel não encontrado ou erro na busca'
            });
        }

        // Verifica se o imóvel já está aprovado
        if (existingListing.active) {
            return res.status(400).json({
                message: 'Imóvel já está aprovado'
            });
        }

        // Atualiza o status do imóvel para ativo e adiciona a data de aprovação
        const { data: updatedListing, error: updateError } = await supabaseClient
            .from('listing')
            .update({ 
                active: true,
                approved_at: new Date().toISOString()
            })
            .eq('id', listingId)
            .select('id, active, approved_at') // Retorna o imóvel atualizado
            .single();

        if (updateError) {
            console.error('Erro ao atualizar o imóvel no Supabase:', updateError);
            return res.status(500).json({
                message: 'Erro ao aprovar o imóvel',
                error: updateError.message
            });
        }

        // Retorna o imóvel atualizado como resposta
        return res.status(200).json({
            message: 'Imóvel aprovado com sucesso',
            listing: updatedListing
        });

    } catch (error) {
        console.error('Erro no servidor:', error);
        return res.status(500).json({
            message: 'Erro interno do servidor',
            error: error.message
        });
    }
});
// Endpoint para criar o título
app.post('/api/listing/title', async (req, res) => {
    const { listingId } = req.body;

    try {
        // Verifica se o ID da listagem foi fornecido
        if (!listingId) {
            return res.status(400).json({ error: 'ID da listagem é obrigatório.' });
        }

        // Obtém a listagem do banco de dados
        const { data: listing, error: fetchError } = await supabase
            .from('listing')
            .select('propertyType, address')
            .eq('id', listingId)
            .single();

        if (fetchError) {
            throw fetchError;
        }

        // Verifica se a listagem foi encontrada
        if (!listing) {
            return res.status(404).json({ error: 'Listagem não encontrada.' });
        }

        // Cria o título
        const title = `${listing.propertyType} em ${listing.address}`;

        // Atualiza o título na tabela
        const { data, error: updateError } = await supabase
            .from('listing')
            .update({ title })
            .eq('id', listingId)
            .select();

        if (updateError) {
            throw updateError;
        }

        // Retorna a resposta de sucesso
        res.status(200).json({ message: 'Título criado com sucesso!', data });
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
