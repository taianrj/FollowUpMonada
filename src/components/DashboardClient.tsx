'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Profile, Task, Client, Collaborator, Status } from '@/types';
import Sidebar from './Sidebar';
import { useNotification } from '@/context/NotificationContext';
import './Dashboard.css';

interface DashboardClientProps {
  initialTasks: Task[];
  initialClients: Client[];
  initialCollaborators: Collaborator[];
  initialStatuses: Status[];
  profile: Profile | null;
}

export default function DashboardClient({
  initialTasks,
  initialClients,
  initialCollaborators,
  initialStatuses,
  profile
}: DashboardClientProps) {
  const supabase = createClient();
  const { showToast, confirm } = useNotification();
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [clients, setClients] = useState<Client[]>(initialClients);
  const [collaborators, setCollaborators] = useState<Collaborator[]>(initialCollaborators);
  const [statuses, setStatuses] = useState<Status[]>(initialStatuses);
  
  const [viewMode, setViewMode] = useState<'table' | 'kanban'>('table');
  const [showArchived, setShowArchived] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  
  // Estados de Filtros
  const [searchFilter, setSearchFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [responsibleFilter, setResponsibleFilter] = useState('');

  // Modais
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  
  // IA
  const [aiText, setAiText] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Demanda Manual / Edição
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [manualClientName, setManualClientName] = useState(''); // Armazenará client_id
  const [manualDescription, setManualDescription] = useState('');
  const [selectedCollaborators, setSelectedCollaborators] = useState<string[]>([]);
  const [manualStatus, setManualStatus] = useState('');
  const [manualObservations, setManualObservations] = useState('');
  const [manualLoading, setManualLoading] = useState(false);

  // Estados do Histórico de Auditoria
  const [activeModalTab, setActiveModalTab] = useState<'edit' | 'history'>('edit');
  const [taskLogs, setTaskLogs] = useState<any[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const fetchTaskHistory = async (taskId: string) => {
    setLoadingLogs(true);
    try {
      const { data, error } = await supabase
        .from('task_history')
        .select(`
          id,
          task_id,
          changed_by,
          changed_at,
          action,
          changes,
          created_by_ai,
          ai_provider,
          profiles:changed_by(name, email)
        `)
        .eq('task_id', taskId)
        .order('changed_at', { ascending: false });

      if (error) throw error;
      setTaskLogs(data || []);
    } catch (err: any) {
      console.error('Erro ao carregar histórico:', err);
      showToast('Erro ao carregar histórico de auditoria.', 'error');
    } finally {
      setLoadingLogs(false);
    }
  };

  // Estado e Ref para seleção de responsáveis customizada
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  // Fecha o dropdown ao clicar fora do componente
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Carrega status padrão no formulário caso existam
  useEffect(() => {
    if (statuses.length > 0 && !manualStatus) {
      setManualStatus(statuses[0].id);
    }
  }, [statuses, manualStatus]);

  // Atualiza todas as tabelas em tempo real
  const refreshData = async () => {
    const { data: refreshedTasks } = await supabase
      .from('tasks')
      .select('*, clients(name)')
      .order('created_at', { ascending: false });
    
    const { data: refreshedClients } = await supabase
      .from('clients')
      .select('*')
      .order('name', { ascending: true });

    const { data: refreshedCollabs } = await supabase
      .from('collaborators')
      .select('*')
      .order('name', { ascending: true });

    const { data: refreshedStatuses } = await supabase
      .from('statuses')
      .select('*')
      .order('created_at', { ascending: true });

    if (refreshedTasks) setTasks(refreshedTasks as Task[]);
    if (refreshedClients) setClients(refreshedClients);
    if (refreshedCollabs) setCollaborators(refreshedCollabs);
    if (refreshedStatuses) setStatuses(refreshedStatuses);
  };

  // Arquivar / Desarquivar Tarefa
  const handleArchiveTask = async (taskId: string, archive: boolean) => {
    if (profile?.role !== 'admin') {
      showToast('Apenas administradores podem arquivar ou desarquivar demandas.', 'warning');
      return;
    }

    const actionText = archive ? 'arquivar' : 'desarquivar';
    const titleText = archive ? 'Arquivar Demanda' : 'Desarquivar Demanda';
    
    if (!await confirm(`Deseja realmente ${actionText} esta demanda?`, titleText)) {
      return;
    }

    const originalTasks = [...tasks];
    
    // Otimista
    setTasks(tasks.map(t => t.id === taskId ? { ...t, is_archived: archive } : t));

    const { error } = await supabase
      .from('tasks')
      .update({ is_archived: archive })
      .eq('id', taskId);

    if (error) {
      showToast('Erro ao atualizar arquivamento: ' + error.message, 'error');
      setTasks(originalTasks);
    } else {
      showToast(archive ? 'Demanda arquivada com sucesso!' : 'Demanda restaurada com sucesso!', 'success');
      
      // Grava histórico
      await supabase
        .from('task_history')
        .insert({
          task_id: taskId,
          changed_by: profile?.id,
          action: archive ? 'archive' : 'restore',
          changes: {
            is_archived: { old: !archive, new: archive }
          },
          created_by_ai: false
        });
    }
  };

  // Deletar tarefa permanentemente (Restrito a Admin)
  const handleDeleteTask = async (taskId: string) => {
    if (profile?.role !== 'admin') {
      showToast('Apenas administradores podem excluir tarefas.', 'warning');
      return;
    }

    if (!await confirm('Deseja excluir permanentemente esta demanda?')) return;

    const originalTasks = [...tasks];
    setTasks(tasks.filter(t => t.id !== taskId));

    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', taskId);

    if (error) {
      showToast('Erro ao excluir tarefa: ' + error.message, 'error');
      setTasks(originalTasks);
    } else {
      showToast('Demanda excluída permanentemente com sucesso!', 'success');
    }
  };

  // Controle de Badges no Modal
  const toggleCollaboratorSelection = (name: string) => {
    if (selectedCollaborators.includes(name)) {
      setSelectedCollaborators(selectedCollaborators.filter(c => c !== name));
    } else {
      setSelectedCollaborators([...selectedCollaborators, name]);
    }
  };

  // Abrir Modal para Nova Demanda
  const openCreateModal = () => {
    setEditingTask(null);
    setManualClientName('');
    setManualDescription('');
    setSelectedCollaborators([]);
    setManualStatus(statuses[0]?.id || '');
    setManualObservations('');
    setActiveModalTab('edit');
    setTaskLogs([]);
    setIsManualModalOpen(true);
  };

  // Abrir Modal para Editar Demanda
  const openEditModal = (task: Task) => {
    setEditingTask(task);
    setManualClientName(task.client_id);
    setManualDescription(task.description);
    setSelectedCollaborators(task.responsibles || []);
    setManualStatus(task.status);
    setManualObservations(task.observations || '');
    setActiveModalTab('edit');
    setTaskLogs([]);
    setIsManualModalOpen(true);
    fetchTaskHistory(task.id);
  };

  // Abrir Modal diretamente na aba de Histórico
  const openHistoryModal = (task: Task) => {
    setEditingTask(task);
    setManualClientName(task.client_id);
    setManualDescription(task.description);
    setSelectedCollaborators(task.responsibles || []);
    setManualStatus(task.status);
    setManualObservations(task.observations || '');
    setActiveModalTab('history');
    setTaskLogs([]);
    setIsManualModalOpen(true);
    fetchTaskHistory(task.id);
  };

  // Salvar Demanda (Criar ou Editar)
  const handleSaveManualTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (profile?.role !== 'admin') {
      showToast('Apenas administradores podem criar ou editar demandas.', 'warning');
      return;
    }

    if (!manualClientName || !manualDescription.trim()) return;

    setManualLoading(true);

    try {
      if (editingTask) {
        // Calcula o diff de alteração
        const changes: Record<string, { old: any; new: any }> = {};
        
        if (editingTask.client_id !== manualClientName) {
          const oldClient = clients.find(c => c.id === editingTask.client_id)?.name || 'Sem Cliente';
          const newClient = clients.find(c => c.id === manualClientName)?.name || 'Sem Cliente';
          changes.client = { old: oldClient, new: newClient };
        }
        
        if (editingTask.description !== manualDescription.trim()) {
          changes.description = { old: editingTask.description, new: manualDescription.trim() };
        }
        
        const oldResps = [...(editingTask.responsibles || [])].sort().join(', ');
        const newResps = [...selectedCollaborators].sort().join(', ');
        if (oldResps !== newResps) {
          changes.responsibles = { 
            old: editingTask.responsibles && editingTask.responsibles.length > 0 ? editingTask.responsibles : ['Sem responsáveis'], 
            new: selectedCollaborators.length > 0 ? selectedCollaborators : ['Sem responsáveis']
          };
        }
        
        if (editingTask.status !== manualStatus) {
          const oldStatus = statuses.find(s => s.id === editingTask.status)?.name || editingTask.status;
          const newStatus = statuses.find(s => s.id === manualStatus)?.name || manualStatus;
          changes.status = { old: oldStatus, new: newStatus };
        }
        
        if ((editingTask.observations || '') !== manualObservations.trim()) {
          changes.observations = { old: editingTask.observations || '', new: manualObservations.trim() };
        }

        // Modo Edição
        const { error: taskErr } = await supabase
          .from('tasks')
          .update({
            client_id: manualClientName,
            description: manualDescription.trim(),
            responsibles: selectedCollaborators,
            status: manualStatus,
            observations: manualObservations.trim()
          })
          .eq('id', editingTask.id);

        if (taskErr) throw taskErr;

        // Se houve modificações, grava no histórico
        if (Object.keys(changes).length > 0) {
          await supabase
            .from('task_history')
            .insert({
              task_id: editingTask.id,
              changed_by: profile?.id,
              action: 'update',
              changes: changes,
              created_by_ai: false
            });
        }
      } else {
        // Modo Criação
        const { data: newTask, error: taskErr } = await supabase
          .from('tasks')
          .insert({
            client_id: manualClientName,
            description: manualDescription.trim(),
            responsibles: selectedCollaborators,
            status: manualStatus,
            observations: manualObservations.trim(),
            is_archived: false,
            created_by: profile?.id
          })
          .select('id')
          .single();

        if (taskErr) throw taskErr;

        // Grava no histórico
        if (newTask) {
          await supabase
            .from('task_history')
            .insert({
              task_id: newTask.id,
              changed_by: profile?.id,
              action: 'create',
              created_by_ai: false
            });
        }
      }

      showToast(editingTask ? 'Demanda atualizada com sucesso!' : 'Demanda cadastrada com sucesso!', 'success');
      setIsManualModalOpen(false);
      await refreshData();
    } catch (err: any) {
      showToast('Erro ao salvar demanda: ' + err.message, 'error');
    } finally {
      setManualLoading(false);
    }
  };

  // Processar texto com IA do Gemini
  const handleProcessAiText = async () => {
    if (profile?.role !== 'admin') {
      showToast('Apenas administradores podem processar textos com IA.', 'warning');
      return;
    }

    if (!aiText.trim()) return;

    setAiLoading(true);
    setAiError(null);

    try {
      const response = await fetch('/api/parse-tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text: aiText, userId: profile?.id })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Erro desconhecido ao processar com IA');
      }

      await refreshData();
      if (result.count && result.count > 0) {
        setAiText('');
        setIsAiModalOpen(false);
        showToast(`Sucesso! Foram adicionadas ${result.count} demandas automaticamente.`, 'success');
      } else {
        setAiError('As demandas já foram adicionadas anteriormente na lista. Nada foi criado.');
      }
    } catch (err: any) {
      console.error(err);
      setAiError(err.message || 'Falha ao processar com a IA.');
    } finally {
      setAiLoading(false);
    }
  };

  // Lista todos os responsáveis únicos existentes em tarefas para os filtros rápidos
  const allResponsiblesInTasks = Array.from(
    new Set(tasks.flatMap(t => t.responsibles || []))
  ).sort();

  // Filtragem Dinâmica das Tarefas baseada nos filtros e na aba ativo/arquivado
  const filteredTasks = tasks.filter(task => {
    // Filtro por arquivamento
    const matchesArchived = task.is_archived === showArchived;

    const clientName = task.clients?.name || '';
    const desc = task.description || '';
    const obs = task.observations || '';
    
    // Filtro de Texto
    const matchesSearch = 
      searchFilter === '' ||
      clientName.toLowerCase().includes(searchFilter.toLowerCase()) ||
      desc.toLowerCase().includes(searchFilter.toLowerCase()) ||
      obs.toLowerCase().includes(searchFilter.toLowerCase());

    // Filtro por Cliente
    const matchesClient = clientFilter === '' || task.client_id === clientFilter;

    // Filtro por Status
    const matchesStatus = statusFilter === '' || task.status === statusFilter;

    // Filtro por Responsável
    const matchesResponsible = 
      responsibleFilter === '' || 
      task.responsibles.includes(responsibleFilter);

    return matchesArchived && matchesSearch && matchesClient && matchesStatus && matchesResponsible;
  });

  return (
    <div className="dashboardLayout">
      <Sidebar profile={profile} isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

      <main className="mainContent">
        {/* Topo do Dashboard */}
        <header className="header">
          <div className="headerTitleWrapper">
            <button className="hamburgerBtn" onClick={() => setIsSidebarOpen(true)} title="Abrir menu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>
            <h1 className="headerTitle">
              {showArchived ? 'Demandas Arquivadas' : 'Painel de Demandas'}
            </h1>
          </div>
          {profile?.role === 'admin' && (
            <div className="headerActions">
              <button className="btn btnAi" onClick={() => { setAiError(null); setIsAiModalOpen(true); }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                  <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
                Processar com IA
              </button>
              
              <button className="btn btnPrimary" onClick={openCreateModal}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                Nova Demanda
              </button>
            </div>
          )}
        </header>

        {/* Resumo de Estatísticas Sutis - Barra Horizontal Compacta */}
        <section className="statsSummaryBar">
          <span className="statsSummaryItem">
            <strong>{showArchived ? 'Total Arquivado' : 'Total Ativas'}:</strong> {filteredTasks.length}
          </span>
          {statuses.map(s => {
            const count = tasks.filter(t => t.status === s.id && t.is_archived === showArchived).length;
            return (
              <span key={s.id} className="statsSummaryItem">
                <span className="statsDot" style={{ backgroundColor: s.color }}></span>
                {s.name}: <strong>{count}</strong>
              </span>
            );
          })}
        </section>

        {/* Barra de Filtros Rápidos */}
        <section className="controlsBar">
          <div className="filtersGroup">
            <div className="filterInputWrapper">
              <input
                className="filterInput"
                type="text"
                placeholder="Buscar demandas..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
              />
            </div>

            <div className="filterInputWrapper">
              <select
                className="filterSelect"
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
              >
                <option value="">Filtrar por Cliente</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div className="filterInputWrapper">
              <select
                className="filterSelect"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">Filtrar por Status</option>
                {statuses.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div className="filterInputWrapper">
              <select
                className="filterSelect"
                value={responsibleFilter}
                onChange={(e) => setResponsibleFilter(e.target.value)}
              >
                <option value="">Filtrar por Responsável</option>
                {allResponsiblesInTasks.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {/* Alternador de Arquivados */}
            <button 
              className={`toggleButton ${showArchived ? 'toggleButtonActive' : ''}`}
              onClick={() => setShowArchived(!showArchived)}
              title={showArchived ? "Visualizar demandas ativas" : "Visualizar demandas arquivadas"}
              style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="21 8 21 21 3 21 3 8"></polyline>
                <rect x="1" y="3" width="22" height="5"></rect>
                <line x1="10" y1="12" x2="14" y2="12"></line>
              </svg>
              {showArchived ? 'Ver Ativas' : 'Ver Arquivadas'}
            </button>
          </div>

          <div className="viewToggleGroup">
            <button 
              className={`toggleButton ${viewMode === 'table' ? 'toggleButtonActive' : ''}`}
              onClick={() => setViewMode('table')}
            >
              Tabela
            </button>
            <button 
              className={`toggleButton ${viewMode === 'kanban' ? 'toggleButtonActive' : ''}`}
              onClick={() => setViewMode('kanban')}
            >
              Kanban
            </button>
          </div>
        </section>

        {/* Listagem de Demandas: Tabela ou Kanban */}
        {viewMode === 'table' ? (
          <>
            <div className="tableContainer desktopOnly">
              <table className="taskTable">
              <thead>
                <tr>
                  <th style={{ width: '15%' }}>Cliente</th>
                  <th style={{ width: '38%' }}>Demanda</th>
                  <th style={{ width: '15%' }}>Responsáveis</th>
                  <th style={{ width: '12%' }}>Status</th>
                  <th style={{ width: '12%' }}>Observações</th>
                  <th style={{ textAlign: 'right', width: '8%' }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
                      Nenhuma demanda encontrada.
                    </td>
                  </tr>
                ) : (
                  filteredTasks.map(task => {
                    const taskStatus = statuses.find(s => s.id === task.status);
                    const statusColor = taskStatus?.color || '#8b5cf6';
                    
                    return (
                      <tr key={task.id} className="taskRow">
                        <td className="clientNameCell">
                          {task.clients?.name || 'Sem Cliente'}
                        </td>
                        <td className="descriptionCell">
                          {task.description}
                        </td>
                        <td>
                          <div className="responsiblesList">
                            {task.responsibles.map((r, i) => (
                              <span key={i} className="responsibleTag" style={{ cursor: 'default' }}>
                                {r}
                              </span>
                            ))}
                            {task.responsibles.length === 0 && (
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                Sem responsáveis
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span 
                            className="statusBadge"
                            style={{
                              backgroundColor: `${statusColor}15`,
                              color: statusColor,
                              borderColor: `${statusColor}35`,
                              borderWidth: '1px',
                              borderStyle: 'solid',
                              cursor: 'default'
                            }}
                          >
                            {taskStatus?.name || task.status}
                          </span>
                        </td>
                        <td>
                          <div 
                            className="obsText" 
                            style={{ cursor: 'default', backgroundColor: 'transparent' }}
                            title={task.observations}
                          >
                            {task.observations || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Sem observações</span>}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
                          <div className="actionsCell">
                            {/* Botão de Edição Completa / Visualização */}
                            <button 
                              className="iconBtn" 
                              onClick={() => openEditModal(task)}
                              title={profile?.role === 'admin' ? "Editar Demanda" : "Visualizar Demanda"}
                            >
                              {profile?.role === 'admin' ? (
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                  <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"></path>
                                </svg>
                              ) : (
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                  <circle cx="12" cy="12" r="3"></circle>
                                </svg>
                              )}
                            </button>

                            {/* Botão de Histórico Direto (Apenas Admin) */}
                            {profile?.role === 'admin' && (
                              <button 
                                className="iconBtn" 
                                onClick={() => openHistoryModal(task)}
                                title="Visualizar Histórico de Alterações"
                              >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                                  <polyline points="3 3 3 8 8 8"></polyline>
                                  <line x1="12" y1="7" x2="12" y2="12"></line>
                                  <line x1="12" y1="12" x2="16" y2="14"></line>
                                </svg>
                              </button>
                            )}

                            {/* Botão de Arquivamento (Apenas Admin) */}
                            {profile?.role === 'admin' && (
                              <button 
                                className="iconBtn" 
                                onClick={() => handleArchiveTask(task.id, !task.is_archived)}
                                title={task.is_archived ? "Desarquivar Demanda" : "Arquivar Demanda"}
                              >
                                {task.is_archived ? (
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="21 8 21 21 3 21 3 8"></polyline>
                                    <rect x="1" y="3" width="22" height="5"></rect>
                                    <polyline points="10 12 12 14 14 12"></polyline>
                                  </svg>
                                ) : (
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="21 8 21 21 3 21 3 8"></polyline>
                                    <rect x="1" y="3" width="22" height="5"></rect>
                                    <line x1="10" y1="12" x2="14" y2="12"></line>
                                  </svg>
                                )}
                              </button>
                            )}

                            {/* Botão de Exclusão (Admin) */}
                            {profile?.role === 'admin' && (
                              <button 
                                className="iconBtn iconBtnDelete" 
                                onClick={() => handleDeleteTask(task.id)}
                                title="Excluir Definitivamente"
                              >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6"></polyline>
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="mobileCardsContainer mobileOnly">
            {filteredTasks.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem', backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                Nenhuma demanda encontrada.
              </div>
            ) : (
              filteredTasks.map(task => {
                const taskStatus = statuses.find(s => s.id === task.status);
                const statusColor = taskStatus?.color || '#8b5cf6';
                
                return (
                  <div key={task.id} className="mobileTaskCard">
                    <div className="mobileCardHeader">
                      <span className="mobileCardClient">
                        {task.clients?.name || 'Sem Cliente'}
                      </span>
                      <span 
                        className="statusBadge"
                        style={{
                          backgroundColor: `${statusColor}15`,
                          color: statusColor,
                          borderColor: `${statusColor}35`,
                          borderWidth: '1px',
                          borderStyle: 'solid',
                          cursor: 'default'
                        }}
                      >
                        {taskStatus?.name || task.status}
                      </span>
                    </div>

                    <div className="mobileCardDesc">
                      {task.description}
                    </div>

                    {task.observations && (
                      <div className="mobileCardObs">
                        <div className="mobileCardObsTitle">Observações</div>
                        <div>{task.observations}</div>
                      </div>
                    )}

                    <div className="mobileCardFooter">
                      <div className="mobileCardResponsibles">
                        {task.responsibles.map((r, i) => (
                          <span key={i} className="responsibleTag" style={{ cursor: 'default' }}>
                            {r}
                          </span>
                        ))}
                        {task.responsibles.length === 0 && (
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            Sem responsáveis
                          </span>
                        )}
                      </div>

                      <div className="mobileCardActions">
                        {/* Editar / Detalhes */}
                        <button 
                          className="iconBtn" 
                          onClick={() => openEditModal(task)}
                          title={profile?.role === 'admin' ? "Editar Demanda" : "Visualizar Demanda"}
                        >
                          {profile?.role === 'admin' ? (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                              <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"></path>
                            </svg>
                          ) : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                              <circle cx="12" cy="12" r="3"></circle>
                            </svg>
                          )}
                        </button>

                        {/* Histórico (Apenas Admin) */}
                        {profile?.role === 'admin' && (
                          <button 
                            className="iconBtn" 
                            onClick={() => openHistoryModal(task)}
                            title="Visualizar Histórico de Alterações"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                              <polyline points="3 3 3 8 8 8"></polyline>
                              <line x1="12" y1="7" x2="12" y2="12"></line>
                              <line x1="12" y1="12" x2="16" y2="14"></line>
                            </svg>
                          </button>
                        )}

                        {/* Arquivar / Desarquivar (Apenas Admin) */}
                        {profile?.role === 'admin' && (
                          <button 
                            className="iconBtn" 
                            onClick={() => handleArchiveTask(task.id, !task.is_archived)}
                            title={task.is_archived ? "Desarquivar Demanda" : "Arquivar Demanda"}
                          >
                            {task.is_archived ? (
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="21 8 21 21 3 21 3 8"></polyline>
                                <rect x="1" y="3" width="22" height="5"></rect>
                                <polyline points="10 12 12 14 14 12"></polyline>
                              </svg>
                            ) : (
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="21 8 21 21 3 21 3 8"></polyline>
                                <rect x="1" y="3" width="22" height="5"></rect>
                                <line x1="10" y1="12" x2="14" y2="12"></line>
                              </svg>
                            )}
                          </button>
                        )}

                        {/* Deletar */}
                        {profile?.role === 'admin' && (
                          <button 
                            className="iconBtn iconBtnDelete" 
                            onClick={() => handleDeleteTask(task.id)}
                            title="Excluir Definitivamente"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="3 6 5 6 21 6"></polyline>
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          </>
        ) : (
          /* Kanban Board Dinâmico */
          <div className="kanbanBoard">
            {statuses.map(s => {
              const statusColor = s.color;
              const columnTasks = filteredTasks.filter(t => t.status === s.id);
              
              return (
                <div key={s.id} className="kanbanColumn" style={{ borderBottom: `3px solid ${statusColor}` }}>
                  <div className="kanbanColumnHeader">
                    <span className="columnTitle">{s.name}</span>
                    <span className="columnCount">{columnTasks.length}</span>
                  </div>

                  <div className="kanbanCardList">
                    {columnTasks.map(task => (
                      <div key={task.id} className="kanbanCard" onClick={() => openEditModal(task)}>
                        <div className="cardHeader">
                          <span className="cardClient" style={{ color: statusColor }}>
                            {task.clients?.name || 'Cliente'}
                          </span>
                          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                            {profile?.role === 'admin' && (
                              <button 
                                className="iconBtn"
                                style={{ padding: '0.2rem' }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openHistoryModal(task);
                                }}
                                title="Visualizar Histórico de Alterações"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                                  <polyline points="3 3 3 8 8 8"></polyline>
                                  <line x1="12" y1="7" x2="12" y2="12"></line>
                                  <line x1="12" y1="12" x2="16" y2="14"></line>
                                </svg>
                              </button>
                            )}
                            {profile?.role === 'admin' && (
                              <button 
                                className="iconBtn"
                                style={{ padding: '0.2rem', fontSize: '1.1rem', lineHeight: '1' }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleArchiveTask(task.id, !task.is_archived);
                                }}
                                title={task.is_archived ? "Desarquivar" : "Arquivar"}
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="cardDesc">{task.description}</div>

                        <div className="responsiblesList" style={{ maxWidth: '100%' }}>
                          {task.responsibles.map((r, i) => (
                            <span key={i} className="responsibleTag" style={{ fontSize: '0.7rem' }}>
                              {r}
                            </span>
                          ))}
                        </div>

                        <div className="cardFooter">
                          <div className="cardObs">
                            {task.observations ? task.observations : 'Sem observações'}
                          </div>
                          
                          <span 
                            className="statusBadge" 
                            style={{ 
                              fontSize: '0.65rem', 
                              padding: '0.25rem 0.6rem',
                              backgroundColor: `${statusColor}15`,
                              color: statusColor,
                              borderColor: `${statusColor}35`,
                              borderWidth: '1px',
                              borderStyle: 'solid',
                              cursor: 'default'
                            }}
                          >
                            {s.name}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Modal de Processamento com IA */}
        {isAiModalOpen && (
          <div className="modalOverlay">
            <div className="modalContent">
              {aiLoading ? (
                <div className="aiLoadingContainer">
                  <div className="spinner"></div>
                  <h2 className="aiLoadingTitle">O FollowUp Mônada está analisando o texto...</h2>
                  <p className="aiLoadingText">
                    Extraindo clientes, criando tarefas, definindo status e alocando responsáveis.
                  </p>
                </div>
              ) : (
                <>
                  <div className="modalHeader">
                    <h2 className="modalTitle">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                        <polyline points="2 17 12 22 22 17"></polyline>
                        <polyline points="2 12 12 17 22 12"></polyline>
                      </svg>
                      Extração Inteligente com IA
                    </h2>
                    <button className="modalCloseBtn" onClick={() => setIsAiModalOpen(false)}>×</button>
                  </div>
                  
                  <div className="modalBody">
                    <p className="modalDescription">
                      Cole resumos de reuniões, e-mails ou anotações livres. A IA extrairá e vinculará as demandas 
                      automaticamente de acordo com seus Clientes, Status e Colaboradores cadastrados.
                    </p>
                    
                    {aiError && (
                      <div className="errorMessage">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                          <circle cx="12" cy="12" r="10"></circle>
                          <line x1="12" y1="8" x2="12" y2="12"></line>
                          <line x1="12" y1="16" x2="12.01" y2="16"></line>
                        </svg>
                        <span>{aiError}</span>
                      </div>
                    )}
                    
                    <textarea
                      className="modalTextarea"
                      placeholder="Cole o texto aqui..."
                      value={aiText}
                      onChange={(e) => setAiText(e.target.value)}
                    />
                  </div>

                  <div className="modalFooter">
                    <button className="btn btnSecondary" onClick={() => setIsAiModalOpen(false)}>Cancelar</button>
                    <button className="btn btnAi" onClick={handleProcessAiText} disabled={!aiText.trim()}>
                      Gerar Demandas
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Modal Unificado: Criação ou Edição de Demanda */}
        {isManualModalOpen && (
          <div className="modalOverlay">
            <div className="modalContent">
              <div className="modalHeader">
                <h2 className="modalTitle">
                  {editingTask ? (profile?.role === 'admin' ? 'Editar Demanda' : 'Detalhes da Demanda') : 'Cadastrar Nova Demanda'}
                </h2>
                <button className="modalCloseBtn" onClick={() => setIsManualModalOpen(false)}>×</button>
              </div>

              {/* Abas do Modal (Visível apenas em modo Edição para Administradores) */}
              {editingTask && profile?.role === 'admin' && (
                <div className="modalTabs">
                  <button
                    type="button"
                    className={`modalTabButton ${activeModalTab === 'edit' ? 'modalTabButtonActive' : ''}`}
                    onClick={() => setActiveModalTab('edit')}
                  >
                    Editar Informações
                  </button>
                  <button
                    type="button"
                    className={`modalTabButton ${activeModalTab === 'history' ? 'modalTabButtonActive' : ''}`}
                    onClick={() => setActiveModalTab('history')}
                  >
                    Histórico de Auditoria
                  </button>
                </div>
              )}

              {activeModalTab === 'edit' ? (
                <form onSubmit={handleSaveManualTask}>
                  <div className="modalBody">
                    
                    {/* Dropdown de Clientes */}
                    <div className="formGroup">
                      <label className="formLabel">Selecione o Cliente</label>
                      <select
                        className="formInput"
                        value={manualClientName}
                        onChange={(e) => setManualClientName(e.target.value)}
                        disabled={profile?.role !== 'admin'}
                        required
                      >
                        <option value="">-- Escolha um Cliente --</option>
                        {clients.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>

                    {/* Descrição da Demanda */}
                    <div className="formGroup">
                      <label className="formLabel">Descrição da Demanda</label>
                      <textarea
                        className="formInput"
                        placeholder="O que precisa ser feito?"
                        value={manualDescription}
                        onChange={(e) => setManualDescription(e.target.value)}
                        disabled={profile?.role !== 'admin'}
                        required
                      />
                    </div>

                    {/* Seleção Múltipla de Responsáveis Customizada (Dropdown Customizado) */}
                    <div className="formGroup" ref={dropdownRef} style={{ position: 'relative' }}>
                      <label className="formLabel">Responsáveis Encarregados</label>
                      <div 
                        className="multiSelectContainer formInput"
                        onClick={() => profile?.role === 'admin' && setIsDropdownOpen(!isDropdownOpen)}
                        style={{ cursor: profile?.role === 'admin' ? 'pointer' : 'default' }}
                      >
                        {selectedCollaborators.map((r, i) => (
                          <span key={i} className="multiSelectTag" style={{ paddingRight: profile?.role === 'admin' ? '0.4rem' : '0.6rem' }}>
                            {r}
                            {profile?.role === 'admin' && (
                              <button
                                type="button"
                                className="multiSelectRemoveBtn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedCollaborators(selectedCollaborators.filter(item => item !== r));
                                }}
                                title="Remover"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                        
                        {selectedCollaborators.length === 0 && (
                          <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', userSelect: 'none' }}>
                            {profile?.role === 'admin' ? 'Clique para selecionar...' : 'Sem responsáveis definidos'}
                          </span>
                        )}

                        {profile?.role === 'admin' && (
                          <span className="multiSelectTrigger">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }}>
                              <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                          </span>
                        )}
                      </div>

                      {/* Menu Dropdown Customizado */}
                      {isDropdownOpen && (
                        <div className="customDropdownMenu">
                          {collaborators.filter(c => !selectedCollaborators.includes(c.name)).length === 0 ? (
                            <div className="disabledItem">
                              {collaborators.length === 0 
                                ? "Nenhum colaborador cadastrado." 
                                : "Todos os colaboradores já foram selecionados."}
                            </div>
                          ) : (
                            collaborators
                              .filter(c => !selectedCollaborators.includes(c.name))
                              .map(c => (
                                <button
                                  type="button"
                                  key={c.id}
                                  className="customDropdownItem"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedCollaborators([...selectedCollaborators, c.name]);
                                    setIsDropdownOpen(false);
                                  }}
                                >
                                  {c.name}
                                </button>
                              ))
                          )}
                        </div>
                      )}
                    </div>

                    {/* Dropdown de Status Dinâmicos */}
                    <div className="formGroup">
                      <label className="formLabel">Status da Demanda</label>
                      <select
                        className="formInput"
                        value={manualStatus}
                        onChange={(e) => setManualStatus(e.target.value)}
                        disabled={profile?.role !== 'admin'}
                        required
                      >
                        {statuses.map(s => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>

                    {/* Observações Extras */}
                    <div className="formGroup">
                      <label className="formLabel">Observações Extras</label>
                      <textarea
                        className="formInput"
                        style={{ minHeight: '60px' }}
                        placeholder="Contexto adicional ou notas"
                        value={manualObservations}
                        onChange={(e) => setManualObservations(e.target.value)}
                        disabled={profile?.role !== 'admin'}
                      />
                    </div>
                  </div>

                  <div className="modalFooter">
                    <button className="btn btnSecondary" type="button" onClick={() => setIsManualModalOpen(false)}>
                      {profile?.role === 'admin' ? 'Cancelar' : 'Fechar'}
                    </button>
                    {profile?.role === 'admin' && (
                      <button className="btn btnPrimary" type="submit" disabled={manualLoading}>
                        {manualLoading ? 'Salvando...' : (editingTask ? 'Salvar Alterações' : 'Criar Demanda')}
                      </button>
                    )}
                  </div>
                </form>
              ) : (
                /* Aba de Histórico de Auditoria */
                <div className="modalBody" style={{ overflowY: 'hidden', display: 'flex', flexDirection: 'column', gap: '0' }}>
                  {loadingLogs ? (
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '3rem', flexDirection: 'column', gap: '1rem' }}>
                      <div className="spinner" style={{ width: '30px', height: '30px' }}></div>
                      <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Carregando histórico...</span>
                    </div>
                  ) : taskLogs.length === 0 ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
                      Nenhum registro de alteração encontrado.
                    </div>
                  ) : (
                    <div className="timelineContainer">
                      {taskLogs.map(log => {
                        const dateText = new Date(log.changed_at).toLocaleString('pt-BR', {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        });

                        let actionLabel = '';
                        let actionClass = 'update';
                        
                        if (log.action === 'create') {
                          actionLabel = log.created_by_ai ? 'Criou a demanda via IA' : 'Criou a demanda';
                          actionClass = 'create';
                        } else if (log.action === 'update') {
                          actionLabel = 'Editou a demanda';
                          actionClass = 'update';
                        } else if (log.action === 'archive') {
                          actionLabel = 'Arquivou a demanda';
                          actionClass = 'archive';
                        } else if (log.action === 'restore') {
                          actionLabel = 'Restaurou a demanda';
                          actionClass = 'restore';
                        }

                        const userName = log.profiles?.name || log.profiles?.email || 'Sistema';

                        return (
                          <div key={log.id} className={`timelineItem timelineItem-${actionClass}`}>
                            <div className="timelineBadge"></div>
                            
                            <div className="timelineHeader">
                              <div>
                                <span className="timelineUser">{userName}</span>{' '}
                                <span className="timelineActionText">{actionLabel}</span>
                              </div>
                              <span className="timelineDate">{dateText}</span>
                            </div>

                            {log.created_by_ai && (
                              <span className="aiBadge">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                                  <polyline points="2 17 12 22 22 17"></polyline>
                                  <polyline points="2 12 12 17 22 12"></polyline>
                                </svg>
                                Criada por IA ({log.ai_provider || 'Modelo não registrado'})
                              </span>
                            )}

                            {log.action === 'update' && log.changes && Object.keys(log.changes).length > 0 && (
                              <div className="timelineContent">
                                <ul className="timelineDiffList">
                                  {Object.entries(log.changes).map(([field, diff]: [string, any]) => {
                                    let fieldLabel = field;
                                    if (field === 'client') fieldLabel = 'Cliente';
                                    if (field === 'description') fieldLabel = 'Demanda';
                                    if (field === 'responsibles') fieldLabel = 'Responsáveis';
                                    if (field === 'status') fieldLabel = 'Status';
                                    if (field === 'observations') fieldLabel = 'Observações';

                                    let oldVal = diff.old;
                                    let newVal = diff.new;

                                    if (Array.isArray(oldVal)) oldVal = oldVal.join(', ');
                                    if (Array.isArray(newVal)) newVal = newVal.join(', ');

                                    return (
                                      <li key={field} className="timelineDiffItem">
                                        <span className="timelineDiffLabel">{fieldLabel}</span>
                                        <div className="timelineDiffValues">
                                          <span className="diffBadge diffBadge-old">{oldVal || 'Vazio'}</span>
                                          <span className="timelineArrow">➔</span>
                                          <span className="diffBadge diffBadge-new">{newVal || 'Vazio'}</span>
                                        </div>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="modalFooter" style={{ marginTop: 'auto' }}>
                    <button className="btn btnSecondary" type="button" onClick={() => setIsManualModalOpen(false)}>Fechar</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
