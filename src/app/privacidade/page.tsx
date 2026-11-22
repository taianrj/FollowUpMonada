import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Política de Privacidade — FollowUp Mônada',
  description: 'Política de privacidade da extensão FollowUp Mônada — Integração WhatsApp Web.',
};

export default function PrivacyPolicyPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0f172a',
        color: '#f8fafc',
        padding: '2.5rem 1.25rem',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <article
        style={{
          maxWidth: '760px',
          margin: '0 auto',
          background: '#1e293b',
          border: '1px solid rgba(148, 163, 184, 0.2)',
          borderRadius: '16px',
          padding: '2rem',
          lineHeight: 1.7,
        }}
      >
        <h1 style={{ fontSize: '1.65rem', fontWeight: 800, marginTop: 0, marginBottom: '0.5rem' }}>
          Política de Privacidade — FollowUp Mônada
        </h1>
        <p style={{ color: '#94a3b8', fontSize: '0.9rem', marginTop: 0, marginBottom: '1.75rem' }}>
          Extensão para Google Chrome: <strong>FollowUp Mônada — Integração WhatsApp Web</strong> • Versão 1.0.0
        </p>

        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', marginBottom: '0.45rem' }}>
            1. Finalidade única da extensão
          </h2>
          <p style={{ color: '#cbd5e1', margin: 0 }}>
            A extensão conecta a aba aberta do WhatsApp Web no navegador do próprio usuário ao aplicativo autenticado{' '}
            <strong>FollowUp Mônada</strong>, permitindo selecionar conversas de uma data específica para gerar resumos
            executivos e sugestões de acompanhamento de demandas.
          </p>
        </section>

        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', marginBottom: '0.45rem' }}>
            2. Dados acessados e como são tratados
          </h2>
          <ul style={{ color: '#cbd5e1', paddingLeft: '1.25rem', margin: 0 }}>
            <li>
              <strong>Ação explícita do usuário:</strong> a extensão só lê mensagens quando o usuário autenticado clica
              expressamente para consultar conversas ou gerar um resumo no Mônada. Não há coleta contínua ou oculta em
              segundo plano.
            </li>
            <li>
              <strong>Armazenamento local:</strong> conversas coletadas, arquivos de áudio temporários (quando a
              transcrição está ativada) e transcrições ficam armazenados localmente no navegador do próprio usuário
              (IndexedDB), com expiração automática.
            </li>
            <li>
              <strong>Envio para IA:</strong> apenas o texto das conversas selecionadas pelo usuário (e os áudios dessas
              conversas, quando a transcrição está habilitada) é enviado ao servidor autenticado do Mônada para
              transcrição e geração do resumo por provedores de IA. O servidor do Mônada não persiste o texto integral
              das conversas nem os arquivos de áudio originais — apenas o resumo executivo final associado à conta do
              usuário.
            </li>
            <li>
              <strong>Sem acesso a credenciais do WhatsApp:</strong> a extensão nunca exporta chaves de criptografia,
              tokens de sessão ou credenciais do WhatsApp.
            </li>
          </ul>
        </section>

        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', marginBottom: '0.45rem' }}>
            3. Compartilhamento e venda de dados
          </h2>
          <p style={{ color: '#cbd5e1', margin: 0 }}>
            O FollowUp Mônada não vende, aluga ou compartilha dados de usuários com terceiros para fins publicitários,
            perfis comerciais ou qualquer finalidade fora da geração do resumo solicitado pelo próprio usuário.
          </p>
        </section>

        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', marginBottom: '0.45rem' }}>
            4. Controle e exclusão pelo usuário
          </h2>
          <p style={{ color: '#cbd5e1', margin: 0 }}>
            O usuário pode selecionar exatamente quais conversas entram em cada resumo, desativar a transcrição de
            áudios a qualquer momento, apagar os dados locais salvos no computador diretamente pela interface do Mônada
            ou desinstalar a extensão pelo Chrome.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', marginBottom: '0.45rem' }}>
            5. Contato
          </h2>
          <p style={{ color: '#cbd5e1', margin: 0 }}>
            Em caso de dúvidas sobre privacidade ou tratamento de dados, entre em contato com o administrador da
            plataforma FollowUp Mônada.
          </p>
        </section>
      </article>
    </main>
  );
}
