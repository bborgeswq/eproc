// === Dados extraídos do scraping ===

export interface ProcessoAberto {
  numero_cnj: string;
  juizo: string;
  requerente_nome: string;
  requerente_cpf: string;
  requerido_nome: string;
  requerido_cpf: string;
  lado_cliente: 'requerente' | 'requerido' | null;
  cliente_nome: string | null;
  cliente_cpf: string | null;
  classe: string;
  assunto: string;
  evento_prazo: string;
  prazo_dias: number | null;
  data_envio_requisicao: string | null;
  data_inicio_prazo: string | null;
  data_final_prazo: string | null;
  raw_data?: Record<string, unknown>;
}

export interface EventoProcesso {
  id?: string;
  numero_cnj: string;
  evento_numero: number | null;
  usuario: string | null;
  data_evento: string | null;
  tipo_evento: string | null;
  descricao: string | null;
  documentos: DocumentoAnexo[] | null;
  raw_data?: Record<string, unknown>;
  // Campos para identificação de prazo
  is_prazo_aberto?: boolean;
  evento_referenciado?: number | null;
}

export interface DocumentoAnexo {
  nome: string;
  tipo: string;
  url?: string;
}

export interface DocumentoProcesso {
  id?: string;
  numero_cnj: string;
  evento_numero: number;
  evento_data: string | null;
  nome_original: string;
  tipo_arquivo: string | null;
  tamanho_bytes: number | null;
  storage_path: string;
  storage_url: string | null;
  created_at?: string;
}

// === Entidades do banco de dados ===

export type ScraperRunStatus = 'running' | 'success' | 'partial' | 'error';

export interface ScraperRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
  status: ScraperRunStatus;
  processos_encontrados: number;
  processos_novos: number;
  processos_removidos: number;
  error_message: string | null;
  error_stack: string | null;
}

// === Configuração ===

export const EPROC_URLS = {
  base: 'https://eproc1g.tjrs.jus.br',
  login: 'https://eproc1g.tjrs.jus.br/eproc/controlador.php?acao=usuario_login_form',
} as const;

export const SELECTORS = {
  login: {
    userInput: '#txtUsuario',
    passInput: '#pwdSenha',
    totpInput: '#txtToken',
    submitBtn: '#btnEntrar',
    errorMsg: '.mensagem-erro',
  },
  painel: {
    // Menu lateral "Painel do Advogado"
    menuPainelAdvogado: 'a[href*="painel_advogado"]',
    // Número azul "65" na linha "Processos com prazo em aberto"
    prazosAbertosQtd: 'td:has-text("Processos com prazo em aberto") + td a',
  },
  listaPrazos: {
    // Tabela de processos com prazo em aberto
    tabela: 'table',
    linhas: 'table tbody tr',
  },
} as const;

// Cor de fundo que indica prazo ABERTO no EPROC (amarelo claro)
export const COR_PRAZO_ABERTO = 'rgb(252, 252, 189)';
