# Encante-se Trilhas

Plataforma web para organizar temas e trilhas musicais por link de arquivo (Google Drive), com persistencia em MySQL.

## Requisitos

- Node.js 20+ (recomendado LTS)
- MySQL 8+ (ou MariaDB compativel)

## Configuracao

1. Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

No Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

2. Ajuste as variaveis do `.env` conforme seu MySQL:

```env
API_PORT=3001
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=encantese_trilhas
```

## Rodar localmente

Instalar dependencias:

```bash
npm install
```

Subir frontend + API:

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- API: `http://localhost:3001`

Opcional (Windows): execute `iniciar_sistema.bat`.

## Banco de dados

Ao iniciar a API, o sistema:

- cria o banco `encantese_trilhas` se nao existir;
- cria as tabelas `themes` e `tracks` automaticamente.

Nao e necessario rodar migration manual neste momento.

## Scripts disponiveis

- `npm run dev` inicia API + frontend
- `npm run dev:api` inicia somente API
- `npm run dev:web` inicia somente frontend
- `npm run build` gera build de producao
- `npm run lint` executa lint

## Observacoes

- A plataforma e de livre acesso (sem autenticacao/usuarios).
- Para reproducao de audio por Drive, o arquivo precisa estar com permissao publica de leitura.
