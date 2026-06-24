'use client';

import React, { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Profile, UserRole } from '@/types';
import Sidebar from './Sidebar';
import { useNotification } from '@/context/NotificationContext';
import './Dashboard.css';

interface AdminClientProps {
  profiles: Profile[];
  currentProfile: Profile;
}

export default function AdminClient({ profiles: initialProfiles, currentProfile }: AdminClientProps) {
  const supabase = createClient();
  const { showToast } = useNotification();
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Estados de convite de usuário
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState<'collaborator' | 'admin'>('collaborator');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Estados de edição de usuário
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<'collaborator' | 'admin'>('collaborator');
  const [editIsActive, setEditIsActive] = useState(true);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [resendingEmails, setResendingEmails] = useState<string[]>([]);

  // Estados para exibição do link gerado
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);
  const [generatedLink, setGeneratedLink] = useState('');
  const [generatedLinkEmail, setGeneratedLinkEmail] = useState('');
  const [isGeneratedLinkNewUser, setIsGeneratedLinkNewUser] = useState(true);
  const [copied, setCopied] = useState(false);

  const handleCopyLink = () => {
    if (!generatedLink) return;
    navigator.clipboard.writeText(generatedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const refreshProfiles = async () => {
    const { data: refreshed } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (refreshed) {
      setProfiles(refreshed as Profile[]);
    }
  };

  const openEditModal = (profile: Profile) => {
    setEditingProfile(profile);
    setEditName(profile.name || '');
    setEditRole(profile.role);
    setEditIsActive(profile.is_active !== false);
    setEditError(null);
    setIsEditModalOpen(true);
  };

  const handleSaveEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProfile || !editName.trim()) return;

    setEditLoading(true);
    setEditError(null);

    try {
      const payload: any = {
        name: editName.trim()
      };

      // Só atualiza a role e o status se não for o próprio usuário
      const isSelf = editingProfile.id === currentProfile.id;
      if (!isSelf) {
        payload.role = editRole;
        payload.is_active = editIsActive;
      }

      const { error } = await supabase
        .from('profiles')
        .update(payload)
        .eq('id', editingProfile.id);

      if (error) throw error;

      showToast('Usuário atualizado com sucesso!', 'success');
      setIsEditModalOpen(false);
      await refreshProfiles();
    } catch (err: any) {
      console.error(err);
      let userFriendlyMessage = err.message || 'Erro ao salvar alterações.';
      
      // Se o erro for relacionado à falta da coluna is_active no banco
      if (err.message && (err.message.includes('is_active') || (err.message.includes('column') && err.message.includes('exist')))) {
        userFriendlyMessage = 'Atenção: A coluna de status ("is_active") não foi localizada no banco de dados. Por favor, execute a migração SQL no painel do Supabase para ativar esta funcionalidade: "alter table public.profiles add column if not exists is_active boolean default true not null;"';
      }
      
      setEditError(userFriendlyMessage);
    } finally {
      setEditLoading(false);
    }
  };

  const handleResendInvite = async (profile: Profile) => {
    if (resendingEmails.includes(profile.email)) return;
    
    setResendingEmails(prev => [...prev, profile.email]);
    
    try {
      const response = await fetch('/api/admin/resend-invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: profile.id,
          email: profile.email,
          name: profile.name || '',
          role: profile.role
        })
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || 'Erro ao reenviar convite.');
      }
      
      setGeneratedLink(result.link);
      setGeneratedLinkEmail(profile.email);
      setIsGeneratedLinkNewUser(result.isNewUser);
      setIsLinkModalOpen(true);
      setCopied(false);
      
      showToast(`Link de acesso gerado com sucesso para ${profile.email}!`, 'success');
    } catch (err: any) {
      console.error(err);
      showToast(err.message || 'Erro ao reenviar convite.', 'error');
    } finally {
      setResendingEmails(prev => prev.filter(email => email !== profile.email));
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim() || !addEmail.trim()) return;

    setAddLoading(true);
    setAddError(null);

    try {
      const response = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: addEmail.trim(),
          name: addName.trim(),
          role: addRole
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Erro ao adicionar usuário.');
      }

      setGeneratedLink(result.link);
      setGeneratedLinkEmail(addEmail.trim());
      setIsGeneratedLinkNewUser(result.isNewUser);
      setIsLinkModalOpen(true);
      setCopied(false);

      showToast(
        result.isNewUser 
          ? 'Link de ativação gerado com sucesso!' 
          : 'Link de recuperação gerado com sucesso!', 
        'success'
      );
      
      setIsAddModalOpen(false);
      setAddName('');
      setAddEmail('');
      setAddRole('collaborator');
      
      // Atualiza a tabela localmente
      await refreshProfiles();
    } catch (err: any) {
      console.error(err);
      setAddError(err.message || 'Erro ao processar convite.');
    } finally {
      setAddLoading(false);
    }
  };

  return (
    <div className="dashboardLayout">
      <Sidebar profile={currentProfile} isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

      <main className="mainContent">
        <header className="header">
          <div className="headerTitleWrapper">
            <button className="hamburgerBtn" onClick={() => setIsSidebarOpen(true)} title="Abrir menu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>
            <h1 className="headerTitle">Usuários e Acessos</h1>
          </div>
          <div className="headerActions">
            <button className="btn btnPrimary" onClick={() => setIsAddModalOpen(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              Adicionar Usuário
            </button>
          </div>
        </header>

        {/* Tabela de Usuários */}
        <div className="tableContainer">
          <table className="taskTable">
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail do Usuário</th>
                <th>Data de Cadastro</th>
                <th>Perfil de Acesso</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(profile => {
                const isSelf = profile.id === currentProfile.id;
                
                return (
                  <tr key={profile.id} className="taskRow">
                    <td className="clientNameCell">
                      {profile.name || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Sem nome</span>} {isSelf && <span style={{ color: 'var(--accent-purple)', fontSize: '0.85rem' }}>(Você)</span>}
                    </td>
                    <td>
                      {profile.email}
                    </td>
                    <td>
                      {new Date(profile.created_at).toLocaleDateString('pt-BR', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </td>
                    <td>
                      <span className={`statusBadge ${profile.role === 'admin' ? 'badge-ajuste' : 'badge-aguardando-cliente'}`} style={{ cursor: 'default' }}>
                        {profile.role === 'admin' ? 'Administrador' : 'Colaborador'}
                      </span>
                    </td>
                    <td>
                      <span className={`statusBadge ${profile.is_active !== false ? 'badge-resolvido' : 'badge-aguardando-texto'}`} style={{ cursor: 'default' }}>
                        {profile.is_active !== false ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
                      <div className="actionsCell">
                        <button 
                          className="iconBtn"
                          onClick={() => openEditModal(profile)}
                          title="Editar Usuário"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"></path>
                          </svg>
                        </button>
                        {!isSelf && (
                          <button 
                            className="iconBtn"
                            onClick={() => handleResendInvite(profile)}
                            disabled={resendingEmails.includes(profile.email)}
                            title="Reenviar E-mail de Convite"
                            style={{ marginLeft: '0.5rem' }}
                          >
                            {resendingEmails.includes(profile.email) ? (
                              <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeDashoffset="8" fill="none" opacity="0.25"></circle>
                                <path d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5 2.3 14.9 3 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
                              </svg>
                            ) : (
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="22" y1="2" x2="11" y2="13"></line>
                                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                              </svg>
                            )}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Modal de Convidar/Adicionar Novo Usuário */}
        {isAddModalOpen && (
          <div className="modalOverlay">
            <div className="modalContent">
              <div className="modalHeader">
                <h2 className="modalTitle">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '0.5rem' }}>
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                    <circle cx="9" cy="7" r="4"></circle>
                    <line x1="19" y1="8" x2="19" y2="14"></line>
                    <line x1="16" y1="11" x2="22" y2="11"></line>
                  </svg>
                  Adicionar Novo Usuário
                </h2>
                <button className="modalCloseBtn" onClick={() => setIsAddModalOpen(false)}>×</button>
              </div>

              <form onSubmit={handleAddUser}>
                <div className="modalBody">
                  <p className="modalDescription" style={{ marginBottom: '1.5rem' }}>
                    Cadastre o nome e e-mail do usuário. O sistema identificará se ele é novo ou já possui cadastro e gerará o link de acesso correspondente para você copiar e enviar.
                  </p>

                  {addError && (
                    <div className="errorMessage">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                      </svg>
                      <span>{addError}</span>
                    </div>
                  )}

                  <div className="formGroup">
                    <label className="formLabel">Nome Completo</label>
                    <input
                      type="text"
                      className="formInput"
                      placeholder="Nome do Usuário"
                      value={addName}
                      onChange={(e) => setAddName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="formGroup">
                    <label className="formLabel">Endereço de E-mail</label>
                    <input
                      type="email"
                      className="formInput"
                      placeholder="email@empresa.com"
                      value={addEmail}
                      onChange={(e) => setAddEmail(e.target.value)}
                      required
                    />
                  </div>

                  <div className="formGroup">
                    <label className="formLabel">Perfil de Acesso</label>
                    <select
                      className="formInput"
                      value={addRole}
                      onChange={(e) => setAddRole(e.target.value as 'collaborator' | 'admin')}
                      required
                    >
                      <option value="collaborator">Colaborador</option>
                      <option value="admin">Administrador</option>
                    </select>
                  </div>
                </div>

                <div className="modalFooter" style={{ marginTop: '1.5rem' }}>
                  <button className="btn btnSecondary" type="button" onClick={() => setIsAddModalOpen(false)}>
                    Cancelar
                  </button>
                  <button className="btn btnPrimary" type="submit" disabled={addLoading}>
                    {addLoading ? 'Gerando Link...' : 'Gerar Link de Acesso'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal de Editar Usuário Existente */}
        {isEditModalOpen && editingProfile && (
          <div className="modalOverlay">
            <div className="modalContent">
              <div className="modalHeader">
                <h2 className="modalTitle">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '0.5rem' }}>
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"></path>
                  </svg>
                  Editar Usuário
                </h2>
                <button className="modalCloseBtn" onClick={() => setIsEditModalOpen(false)}>×</button>
              </div>

              <form onSubmit={handleSaveEditUser}>
                <div className="modalBody">
                  <p className="modalDescription" style={{ marginBottom: '1.5rem' }}>
                    Edite as informações cadastrais do usuário <strong>{editingProfile.email}</strong>.
                  </p>

                  {editError && (
                    <div className="errorMessage">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                      </svg>
                      <span>{editError}</span>
                    </div>
                  )}

                  <div className="formGroup">
                    <label className="formLabel">Nome Completo</label>
                    <input
                      type="text"
                      className="formInput"
                      placeholder="Nome do Usuário"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="formGroup">
                    <label className="formLabel">Perfil de Acesso</label>
                    <select
                      className="formInput"
                      value={editRole}
                      onChange={(e) => setEditRole(e.target.value as 'collaborator' | 'admin')}
                      disabled={editingProfile.id === currentProfile.id}
                      required
                    >
                      <option value="collaborator">Colaborador</option>
                      <option value="admin">Administrador</option>
                    </select>
                    {editingProfile.id === currentProfile.id && (
                      <span className="formHelpText" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem', display: 'block' }}>
                        Você não pode alterar seu próprio perfil de acesso por motivos de segurança.
                      </span>
                    )}
                  </div>

                  <div className="formGroup">
                    <label className="formLabel">Status da Conta</label>
                    <select
                      className="formInput"
                      value={editIsActive ? 'true' : 'false'}
                      onChange={(e) => setEditIsActive(e.target.value === 'true')}
                      disabled={editingProfile.id === currentProfile.id}
                      required
                    >
                      <option value="true">Ativo</option>
                      <option value="false">Inativo (Suspenso)</option>
                    </select>
                    {editingProfile.id === currentProfile.id && (
                      <span className="formHelpText" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem', display: 'block' }}>
                        Você não pode desativar sua própria conta.
                      </span>
                    )}
                  </div>
                </div>

                <div className="modalFooter" style={{ marginTop: '1.5rem' }}>
                  <button className="btn btnSecondary" type="button" onClick={() => setIsEditModalOpen(false)}>
                    Cancelar
                  </button>
                  <button className="btn btnPrimary" type="submit" disabled={editLoading}>
                    {editLoading ? 'Salvando...' : 'Salvar Alterações'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal de Exibição de Link Gerado */}
        {isLinkModalOpen && (
          <div className="modalOverlay">
            <div className="modalContent" style={{ maxWidth: '500px' }}>
              <div className="modalHeader">
                <h2 className="modalTitle">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '0.5rem', color: 'var(--accent-purple)' }}>
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                  </svg>
                  Link de Acesso Gerado
                </h2>
                <button className="modalCloseBtn" onClick={() => setIsLinkModalOpen(false)}>×</button>
              </div>

              <div className="modalBody">
                <p className="modalDescription" style={{ marginBottom: '1.25rem' }}>
                  {isGeneratedLinkNewUser ? (
                    <>
                      O usuário <strong>{generatedLinkEmail}</strong> não possui cadastro ativo. Copie o link de <strong>ativação de conta</strong> abaixo e envie para ele:
                    </>
                  ) : (
                    <>
                      O usuário <strong>{generatedLinkEmail}</strong> já possui cadastro. Copie o link de <strong>redefinição de senha</strong> abaixo e envie para ele:
                    </>
                  )}
                </p>

                <div className="formGroup">
                  <label className="formLabel">Link para envio</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      className="formInput"
                      value={generatedLink}
                      readOnly
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                      style={{ backgroundColor: 'var(--bg-input-disabled, #1e293b)', cursor: 'pointer' }}
                    />
                    <button
                      className="btn btnPrimary"
                      onClick={handleCopyLink}
                      style={{ whiteSpace: 'nowrap', minWidth: '90px' }}
                    >
                      {copied ? 'Copiado!' : 'Copiar'}
                    </button>
                  </div>
                </div>

                <div className="infoBox" style={{ marginTop: '1.25rem', padding: '0.75rem', borderRadius: '6px', backgroundColor: 'rgba(139, 92, 246, 0.1)', border: '1px solid rgba(139, 92, 246, 0.2)', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  <strong style={{ color: 'var(--accent-purple)', display: 'block', marginBottom: '0.25rem' }}>Como proceder?</strong>
                  Envie este link para o usuário através do WhatsApp, Teams, e-mail ou outro meio de comunicação direta. O link permitirá que ele defina sua senha com segurança.
                </div>
              </div>

              <div className="modalFooter" style={{ marginTop: '1.5rem' }}>
                <button className="btn btnSecondary" type="button" onClick={() => setIsLinkModalOpen(false)} style={{ width: '100%' }}>
                  Fechar
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
