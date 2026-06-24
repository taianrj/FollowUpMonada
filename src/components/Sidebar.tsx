'use client';

import React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Profile } from '@/types';

interface SidebarProps {
  profile: Profile | null;
  isOpen?: boolean;
  onClose?: () => void;
}

export default function Sidebar({ profile, isOpen, onClose }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const isAdmin = profile?.role === 'admin';

  return (
    <>
      {/* Backdrop de fundo no mobile */}
      {isOpen && <div className="sidebarOverlay" onClick={onClose} />}

      <aside className={`sidebar ${isOpen ? 'sidebarOpen' : ''}`}>
        {/* Botão de Fechar no mobile */}
        <button type="button" className="sidebarCloseBtn" onClick={onClose} title="Fechar menu">
          ×
        </button>

        <div className="sidebarTop">
        <div className="sidebarLogo">FollowUp Mônada</div>
        
        <nav className="sidebarNav">
          <button 
            className={`navLink ${pathname === '/' ? 'navLinkActive' : ''}`}
            onClick={() => router.push('/')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="7"></rect>
              <rect x="14" y="14" width="7" height="7"></rect>
              <rect x="3" y="14" width="7" height="7"></rect>
            </svg>
            Painel de Demandas
          </button>
          
          {isAdmin && (
            <button 
              className={`navLink ${pathname === '/cadastros' ? 'navLinkActive' : ''}`}
              onClick={() => router.push('/cadastros')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
              </svg>
              Cadastros Gerais
            </button>
          )}
          
          {isAdmin && (
            <button 
              className={`navLink ${pathname === '/admin' ? 'navLinkActive' : ''}`}
              onClick={() => router.push('/admin')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
              </svg>
              Usuários e Acessos
            </button>
          )}
        </nav>
      </div>

      <div className="sidebarUser">
        <div className="userInfo">
          <span className="userEmail" title={profile?.email || ''} style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {profile?.name || profile?.email || 'carregando...'}
          </span>
          {profile?.name && (
            <span className="userEmailSub" title={profile.email} style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '0.1rem' }}>
              {profile.email}
            </span>
          )}
          {profile && (
            <span className={`roleBadge ${profile.role === 'admin' ? 'roleAdmin' : 'roleCollaborator'}`} style={{ marginTop: '0.35rem', display: 'inline-block', width: 'fit-content' }}>
              {profile.role === 'admin' ? 'Administrador' : 'Colaborador'}
            </span>
          )}
        </div>

        <button className="logoutButton" onClick={handleLogout}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
            <polyline points="16 17 21 12 16 7"></polyline>
            <line x1="21" y1="12" x2="9" y2="12"></line>
          </svg>
          Sair do Sistema
        </button>
      </div>
    </aside>
    </>
  );
}
