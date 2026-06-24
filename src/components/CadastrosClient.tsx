'use client';

import React, { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Client, Collaborator, Status, Profile } from '@/types';
import Sidebar from './Sidebar';
import { useNotification } from '@/context/NotificationContext';
import './Dashboard.css';

interface CadastrosClientProps {
  initialClients: Client[];
  initialCollaborators: Collaborator[];
  initialStatuses: Status[];
  profile: Profile | null;
}

type ActiveTab = 'clients' | 'collaborators' | 'statuses';

export default function CadastrosClient({
  initialClients,
  initialCollaborators,
  initialStatuses,
  profile
}: CadastrosClientProps) {
  const supabase = createClient();
  const { showToast, confirm } = useNotification();
  const isAdmin = profile?.role === 'admin';

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Abas
  const [activeTab, setActiveTab] = useState<ActiveTab>('clients');

  // Estados dos Dados
  const [clients, setClients] = useState<Client[]>(initialClients);
  const [collaborators, setCollaborators] = useState<Collaborator[]>(initialCollaborators);
  const [statuses, setStatuses] = useState<Status[]>(initialStatuses);

  // Estados de Loading e Edição
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Formulário - Clientes
  const [clientName, setClientName] = useState('');

  // Formulário - Colaboradores
  const [collaboratorName, setCollaboratorName] = useState('');

  // Formulário - Status
  const [statusId, setStatusId] = useState('');
  const [statusName, setStatusName] = useState('');
  const [statusColor, setStatusColor] = useState('#8b5cf6');

  // ==========================================
  // LÓGICA DE CLIENTES
  // ==========================================
  const handleClientSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientName.trim() || loading) return;

    setLoading(true);
    try {
      if (editingId) {
        // Atualizar
        const { data, error } = await supabase
          .from('clients')
          .update({ name: clientName.trim() })
          .eq('id', editingId)
          .select()
          .single();

        if (error) throw error;
        setClients(clients.map(c => c.id === editingId ? (data as Client) : c));
        setEditingId(null);
      } else {
        // Criar
        const { data, error } = await supabase
          .from('clients')
          .insert({ name: clientName.trim() })
          .select()
          .single();

        if (error) throw error;
        setClients([...clients, data as Client].sort((a, b) => a.name.localeCompare(b.name)));
      }
      showToast(editingId ? 'Cliente atualizado com sucesso!' : 'Cliente cadastrado com sucesso!', 'success');
      setClientName('');
    } catch (err: any) {
      showToast('Erro ao salvar cliente: ' + (err.message || 'Nome já cadastrado.'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEditClient = (client: Client) => {
    setEditingId(client.id);
    setClientName(client.name);
  };

  const handleDeleteClient = async (id: string) => {
    if (!isAdmin) {
      showToast('Apenas administradores podem excluir clientes.', 'warning');
      return;
    }
    if (!await confirm('Excluir este cliente apagará todas as demandas associadas a ele. Deseja continuar?', 'Excluir Cliente')) return;

    try {
      const { error } = await supabase
        .from('clients')
        .delete()
        .eq('id', id);

      if (error) throw error;
      setClients(clients.filter(c => c.id !== id));
      showToast('Cliente excluído com sucesso!', 'success');
      if (editingId === id) {
        setEditingId(null);
        setClientName('');
      }
    } catch (err: any) {
      showToast('Erro ao excluir cliente: ' + err.message, 'error');
    }
  };

  // ==========================================
  // LÓGICA DE COLABORADORES
  // ==========================================
  const handleCollaboratorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!collaboratorName.trim() || loading) return;

    setLoading(true);
    try {
      if (editingId) {
        // Atualizar
        const { data, error } = await supabase
          .from('collaborators')
          .update({ name: collaboratorName.trim() })
          .eq('id', editingId)
          .select()
          .single();

        if (error) throw error;
        setCollaborators(collaborators.map(c => c.id === editingId ? (data as Collaborator) : c));
        setEditingId(null);
      } else {
        // Criar
        const { data, error } = await supabase
          .from('collaborators')
          .insert({ name: collaboratorName.trim() })
          .select()
          .single();

        if (error) throw error;
        setCollaborators([...collaborators, data as Collaborator].sort((a, b) => a.name.localeCompare(b.name)));
      }
      showToast(editingId ? 'Colaborador atualizado com sucesso!' : 'Colaborador cadastrado com sucesso!', 'success');
      setCollaboratorName('');
    } catch (err: any) {
      showToast('Erro ao salvar colaborador: ' + (err.message || 'Colaborador já cadastrado.'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEditCollaborator = (collaborator: Collaborator) => {
    setEditingId(collaborator.id);
    setCollaboratorName(collaborator.name);
  };

  const handleDeleteCollaborator = async (id: string) => {
    if (!isAdmin) {
      showToast('Apenas administradores podem excluir colaboradores.', 'warning');
      return;
    }
    if (!await confirm('Deseja excluir permanentemente este colaborador?', 'Excluir Colaborador')) return;

    try {
      const { error } = await supabase
        .from('collaborators')
        .delete()
        .eq('id', id);

      if (error) throw error;
      setCollaborators(collaborators.filter(c => c.id !== id));
      showToast('Colaborador excluído com sucesso!', 'success');
      if (editingId === id) {
        setEditingId(null);
        setCollaboratorName('');
      }
    } catch (err: any) {
      showToast('Erro ao excluir colaborador: ' + err.message, 'error');
    }
  };

  // ==========================================
  // LÓGICA DE STATUS
  // ==========================================
  const handleStatusSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statusId.trim() || !statusName.trim() || loading) return;

    setLoading(true);
    const slug = statusId.trim().toLowerCase().replace(/\s+/g, '-');

    try {
      if (editingId) {
        // Atualizar
        const { data, error } = await supabase
          .from('statuses')
          .update({
            name: statusName.trim(),
            color: statusColor
          })
          .eq('id', editingId)
          .select()
          .single();

        if (error) throw error;
        setStatuses(statuses.map(s => s.id === editingId ? (data as Status) : s));
        setEditingId(null);
      } else {
        // Criar
        const { data, error } = await supabase
          .from('statuses')
          .insert({
            id: slug,
            name: statusName.trim(),
            color: statusColor
          })
          .select()
          .single();

        if (error) throw error;
        setStatuses([...statuses, data as Status]);
      }
      showToast(editingId ? 'Status atualizado com sucesso!' : 'Status cadastrado com sucesso!', 'success');
      setStatusId('');
      setStatusName('');
      setStatusColor('#8b5cf6');
    } catch (err: any) {
      showToast('Erro ao salvar status: ' + (err.message || 'Status ID/Slug já em uso.'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEditStatus = (status: Status) => {
    setEditingId(status.id);
    setStatusId(status.id);
    setStatusName(status.name);
    setStatusColor(status.color);
  };

  const handleDeleteStatus = async (id: string) => {
    if (!isAdmin) {
      showToast('Apenas administradores podem excluir status.', 'warning');
      return;
    }
    if (!await confirm('Deseja excluir este status?', 'Excluir Status')) return;

    try {
      const { error } = await supabase
        .from('statuses')
        .delete()
        .eq('id', id);

      if (error) {
        if (error.code === '23503') {
          throw new Error('Não é possível excluir este status pois existem demandas utilizando ele atualmente. Mude os status das demandas antes de excluí-lo.');
        }
        throw error;
      }
      setStatuses(statuses.filter(s => s.id !== id));
      showToast('Status excluído com sucesso!', 'success');
      if (editingId === id) {
        setEditingId(null);
        setStatusId('');
        setStatusName('');
      }
    } catch (err: any) {
      showToast('Erro ao excluir status: ' + err.message, 'error');
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setClientName('');
    setCollaboratorName('');
    setStatusId('');
    setStatusName('');
    setStatusColor('#8b5cf6');
  };

  return (
    <div className="dashboardLayout">
      <Sidebar profile={profile} isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

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
            <h1 className="headerTitle">Cadastros Gerais</h1>
          </div>
        </header>

        {/* Abas */}
        <div className="tabsContainer">
          <button
            className={`tabButton ${activeTab === 'clients' ? 'tabButtonActive' : ''}`}
            onClick={() => { setActiveTab('clients'); resetForm(); }}
          >
            Clientes ({clients.length})
          </button>
          <button
            className={`tabButton ${activeTab === 'collaborators' ? 'tabButtonActive' : ''}`}
            onClick={() => { setActiveTab('collaborators'); resetForm(); }}
          >
            Colaboradores ({collaborators.length})
          </button>
          <button
            className={`tabButton ${activeTab === 'statuses' ? 'tabButtonActive' : ''}`}
            onClick={() => { setActiveTab('statuses'); resetForm(); }}
          >
            Status ({statuses.length})
          </button>
        </div>

        {/* Conteúdo das Abas */}
        <section className="cadastrosGrid">
          
          {/* Coluna Esquerda: Formulários */}
          <div className="cadastrosFormCard">
            <h2 className="cadastrosFormCardTitle">
              {editingId ? 'Editar Cadastro' : 'Novo Cadastro'}
            </h2>

            {activeTab === 'clients' && (
              <form onSubmit={handleClientSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div className="formGroup">
                  <label className="formLabel">Nome do Cliente</label>
                  <input
                    className="formInput"
                    type="text"
                    placeholder="Ex: Empresa Acme"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    required
                  />
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btnPrimary" type="submit" style={{ flex: 1, justifyContent: 'center' }} disabled={loading}>
                    {editingId ? 'Salvar' : 'Cadastrar'}
                  </button>
                  {editingId && (
                    <button className="btn btnSecondary" type="button" onClick={resetForm}>Cancelar</button>
                  )}
                </div>
              </form>
            )}

            {activeTab === 'collaborators' && (
              <form onSubmit={handleCollaboratorSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div className="formGroup">
                  <label className="formLabel">Nome do Colaborador</label>
                  <input
                    className="formInput"
                    type="text"
                    placeholder="Ex: Carlos Silva"
                    value={collaboratorName}
                    onChange={(e) => setCollaboratorName(e.target.value)}
                    required
                  />
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btnPrimary" type="submit" style={{ flex: 1, justifyContent: 'center' }} disabled={loading}>
                    {editingId ? 'Salvar' : 'Cadastrar'}
                  </button>
                  {editingId && (
                    <button className="btn btnSecondary" type="button" onClick={resetForm}>Cancelar</button>
                  )}
                </div>
              </form>
            )}

            {activeTab === 'statuses' && (
              <form onSubmit={handleStatusSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div className="formGroup">
                  <label className="formLabel">Código (Slug único)</label>
                  <input
                    className="formInput"
                    type="text"
                    placeholder="Ex: aguardando-aprovacao"
                    value={statusId}
                    onChange={(e) => setStatusId(e.target.value)}
                    disabled={!!editingId}
                    required
                  />
                </div>

                <div className="formGroup">
                  <label className="formLabel">Nome Exibido</label>
                  <input
                    className="formInput"
                    type="text"
                    placeholder="Ex: Aguardando Aprovação"
                    value={statusName}
                    onChange={(e) => setStatusName(e.target.value)}
                    required
                  />
                </div>

                <div className="formGroup">
                  <label className="formLabel">Cor Temática</label>
                  <div className="colorInputContainer">
                    <div className="colorPickerCircle" style={{ backgroundColor: statusColor }}>
                      <input
                        className="colorPickerInput"
                        type="color"
                        value={statusColor}
                        onChange={(e) => setStatusColor(e.target.value)}
                      />
                    </div>
                    <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{statusColor}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btnPrimary" type="submit" style={{ flex: 1, justifyContent: 'center' }} disabled={loading}>
                    {editingId ? 'Salvar' : 'Cadastrar'}
                  </button>
                  {editingId && (
                    <button className="btn btnSecondary" type="button" onClick={resetForm}>Cancelar</button>
                  )}
                </div>
              </form>
            )}
          </div>

          {/* Coluna Direita: Tabelas de Listagem */}
          <div className="tableContainer">
            {activeTab === 'clients' && (
              <table className="taskTable">
                <thead>
                  <tr>
                    <th>Nome do Cliente</th>
                    <th style={{ textAlign: 'right', width: '120px' }}>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.length === 0 ? (
                    <tr>
                      <td colSpan={2} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>
                        Nenhum cliente cadastrado.
                      </td>
                    </tr>
                  ) : (
                    clients.map(client => (
                      <tr key={client.id} className="taskRow">
                        <td className="clientNameCell">{client.name}</td>
                        <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
                          <div className="actionsCell">
                            <button className="iconBtn" onClick={() => handleEditClient(client)} title="Editar Nome">
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"></path>
                              </svg>
                            </button>
                            {isAdmin && (
                              <button className="iconBtn iconBtnDelete" onClick={() => handleDeleteClient(client.id)} title="Excluir Cliente">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6"></polyline>
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}

            {activeTab === 'collaborators' && (
              <table className="taskTable">
                <thead>
                  <tr>
                    <th>Nome do Colaborador</th>
                    <th style={{ textAlign: 'right', width: '120px' }}>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {collaborators.length === 0 ? (
                    <tr>
                      <td colSpan={2} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>
                        Nenhum colaborador cadastrado.
                      </td>
                    </tr>
                  ) : (
                    collaborators.map(collab => (
                      <tr key={collab.id} className="taskRow">
                        <td className="clientNameCell">{collab.name}</td>
                        <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
                          <div className="actionsCell">
                            <button className="iconBtn" onClick={() => handleEditCollaborator(collab)} title="Editar Nome">
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"></path>
                              </svg>
                            </button>
                            {isAdmin && (
                              <button className="iconBtn iconBtnDelete" onClick={() => handleDeleteCollaborator(collab.id)} title="Excluir Colaborador">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6"></polyline>
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}

            {activeTab === 'statuses' && (
              <table className="taskTable">
                <thead>
                  <tr>
                    <th>Código (Slug)</th>
                    <th>Nome Exibido</th>
                    <th>Visualização da Badge</th>
                    <th style={{ textAlign: 'right', width: '120px' }}>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {statuses.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>
                        Nenhum status cadastrado.
                      </td>
                    </tr>
                  ) : (
                    statuses.map(st => (
                      <tr key={st.id} className="taskRow">
                        <td><code>{st.id}</code></td>
                        <td className="clientNameCell">{st.name}</td>
                        <td>
                          <span
                            className="statusBadge"
                            style={{
                              backgroundColor: `${st.color}15`,
                              color: st.color,
                              borderColor: `${st.color}35`,
                              borderWidth: '1px',
                              borderStyle: 'solid'
                            }}
                          >
                            {st.name}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
                          <div className="actionsCell">
                            <button className="iconBtn" onClick={() => handleEditStatus(st)} title="Editar Status">
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"></path>
                              </svg>
                            </button>
                            {isAdmin && (
                              <button className="iconBtn iconBtnDelete" onClick={() => handleDeleteStatus(st.id)} title="Excluir Status">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6"></polyline>
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
