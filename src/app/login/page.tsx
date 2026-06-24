'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import './login.css';

type LoginMode = 'login' | 'forgot' | 'reset';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [mode, setMode] = useState<LoginMode>('login');
  
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    let subscription: any = null;

    if (searchParams.get('mode') === 'reset') {
      setMode('reset');
      
      // Busca o e-mail do usuário ativo temporariamente para preencher o formulário de redefinição
      const fetchResetUser = async () => {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            setEmail(user.email || '');
          }
        } catch (e) {
          console.error('Erro ao obter usuário para redefinição:', e);
        }
      };
      fetchResetUser();

      // Escuta mudanças de autenticação para preencher o e-mail assim que o hash for processado
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (session?.user) {
          setEmail(session.user.email || '');
        }
      });
      subscription = data.subscription;
    }
    
    let errorParam = searchParams.get('error');
    
    // Captura erros no fragmento de hash da URL (padrão de redirecionamento do Supabase Auth para links expirados)
    if (typeof window !== 'undefined' && window.location.hash) {
      try {
        const hashParams = new URLSearchParams(window.location.hash.substring(1));
        const errorCode = hashParams.get('error_code');
        const errorDesc = hashParams.get('error_description');
        
        if (errorCode === 'otp_expired' || (errorDesc && errorDesc.toLowerCase().includes('expired'))) {
          errorParam = 'O link de acesso/recuperação enviado por e-mail expirou ou já foi utilizado. Por favor, tente enviar novamente.';
        } else if (hashParams.get('error')) {
          errorParam = errorDesc || hashParams.get('error');
        }
      } catch (e) {
        console.error('Erro ao ler fragmento de hash:', e);
      }
    }
    
    if (errorParam) {
      if (errorParam === 'Falha na autenticação') {
        errorParam = 'Falha na autenticação. O link de e-mail pode ter expirado, ter sido consumido pelo seu servidor de e-mail (antivírus) ou já foi utilizado. Por favor, solicite outro.';
      }
      setError(errorParam);
    }

    return () => {
      if (subscription) {
        subscription.unsubscribe();
      }
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) throw signInError;

      router.push('/');
      router.refresh();
    } catch (err: any) {
      console.error(err);
      setError(getFriendlyErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/login?mode=reset')}`
      });

      if (resetError) throw resetError;

      setSuccessMsg('E-mail de recuperação enviado! Verifique sua caixa de entrada.');
    } catch (err: any) {
      console.error(err);
      setError(getFriendlyErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('As senhas não coincidem.');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: password
      });

      if (updateError) throw updateError;

      setSuccessMsg('Senha redefinida com sucesso! Redirecionando...');
      setTimeout(() => {
        router.push('/');
        router.refresh();
      }, 1500);
    } catch (err: any) {
      console.error(err);
      setError(getFriendlyErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const renderForm = () => {
    if (mode === 'forgot') {
      return (
        <form onSubmit={handleForgot}>
          <div className="formGroup">
            <label className="formLabel" htmlFor="email">E-mail de Recuperação</label>
            <input
              className="formInput"
              type="email"
              id="email"
              name="email"
              autoComplete="email"
              placeholder="seu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <button className="submitButton" type="submit" disabled={loading}>
            {loading ? 'Enviando...' : 'Enviar Link de Recuperação'}
          </button>

          <button 
            type="button"
            className="loginLinkButton" 
            onClick={() => {
              setMode('login');
              setError(null);
              setSuccessMsg(null);
            }}
          >
            Voltar para o Login
          </button>
        </form>
      );
    }

    if (mode === 'reset') {
      return (
        <form onSubmit={handleReset}>
          <div className="formGroup">
            <label className="formLabel" htmlFor="email-reset">E-mail de Acesso</label>
            <input
              className="formInput"
              type="email"
              id="email-reset"
              name="email"
              autoComplete="username"
              value={email}
              disabled
              required
            />
          </div>

          <div className="formGroup">
            <label className="formLabel" htmlFor="password">Nova Senha</label>
            <input
              className="formInput"
              type="password"
              id="password"
              name="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>

          <div className="formGroup">
            <label className="formLabel" htmlFor="confirmPassword">Confirmar Nova Senha</label>
            <input
              className="formInput"
              type="password"
              id="confirmPassword"
              name="confirmPassword"
              autoComplete="new-password"
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>

          <button className="submitButton" type="submit" disabled={loading}>
            {loading ? 'Definindo...' : 'Definir Nova Senha'}
          </button>
        </form>
      );
    }

    // Default: login
    return (
      <form onSubmit={handleLogin}>
        <div className="formGroup">
          <label className="formLabel" htmlFor="email">E-mail</label>
          <input
            className="formInput"
            type="email"
            id="email"
            name="email"
            autoComplete="username"
            placeholder="seu@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="formGroup">
          <label className="formLabel" htmlFor="password">Senha</label>
          <input
            className="formInput"
            type="password"
            id="password"
            name="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />
        </div>

        <button className="submitButton" type="submit" disabled={loading}>
          {loading ? 'Processando...' : 'Entrar'}
        </button>

        <button 
          type="button"
          className="loginLinkButton" 
          onClick={() => {
            setMode('forgot');
            setError(null);
            setSuccessMsg(null);
          }}
        >
          Esqueci minha senha
        </button>
      </form>
    );
  };

  return (
    <main className="loginContainer">
      <div className="loginCard">
        <header className="loginHeader">
          <h1 className="logoTitle">FollowUp Mônada</h1>
          <p className="loginSubtitle">
            {mode === 'forgot' && 'Recuperação de acesso por e-mail'}
            {mode === 'reset' && 'Defina sua nova senha de acesso'}
            {mode === 'login' && 'Acesse o gerenciador de demandas'}
          </p>
        </header>

        {error && (
          <div className="errorMessage">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="errorMessage" style={{ backgroundColor: 'rgba(16, 185, 129, 0.1)', borderColor: 'rgba(16, 185, 129, 0.2)', color: '#10b981' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <span>{successMsg}</span>
          </div>
        )}

        {renderForm()}
      </div>
    </main>
  );
}

function getFriendlyErrorMessage(err: any): string {
  const msg = err?.message || '';
  const lowerMsg = msg.toLowerCase();
  
  if (lowerMsg.includes('email rate limit exceeded')) {
    return 'Muitas solicitações seguidas. Por favor, aguarde pelo menos um minuto antes de tentar de novo.';
  }
  if (lowerMsg.includes('invalid login credentials')) {
    return 'E-mail ou senha inválidos. Por favor, tente de novo.';
  }
  if (lowerMsg.includes('signup is disabled')) {
    return 'O auto-cadastro de novos usuários está desativado no sistema.';
  }
  if (lowerMsg.includes('invalid email') || lowerMsg.includes('email format')) {
    return 'Por favor, digite um endereço de e-mail válido.';
  }
  
  return msg || 'Ocorreu um erro ao processar sua solicitação.';
}
