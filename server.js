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

    try {
        const { error } = await supabaseClient
            .from('schedules')
            .update({ negotiation_status: 'closed' })
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

            // URL para marcar negociação como fechada
            const closeNegotiationUrl = `${process.env.BASE_URL}/api/close-negotiation/${id}`;

            // Montar a mensagem de acompanhamento com botão para fechar negociação
            const message = `
                <p>Olá ${user_name},</p>
                <p>Você teve uma visita agendada no dia ${visitDate.toLocaleDateString()}. Gostaríamos de saber como foi a visita e qual é o estado da negociação.</p>
                <p>Se você já fechou a negociação, clique no botão abaixo:</p>
                <a href="${closeNegotiationUrl}" style="padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none;">Fechar Negociação</a>
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
    }
};


// Iniciar o monitoramento de visitas a cada 1 hora
setInterval(monitorVisits, 60 * 60 * 1000);

app.listen(port, () => {
    console.log(`Executando em http://localhost:${port}`);
});
