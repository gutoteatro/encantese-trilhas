import React from 'react';
import { Music, Search, Upload } from 'lucide-react';
import headerImage from '../assets/cabecalho_imagem.png';

export default function Layout({ children, searchTerm, onSearchChange, activeView, onChangeView }) {
  const navItems = [
    { id: 'dashboard', label: 'Voltar Para Página de Trilhas', icon: <Music size={18} /> },
    { id: 'upload', label: 'UPLOAD DE TRILHAS', icon: <Upload size={18} /> },
  ];
  const visibleNavItems = navItems.filter((item) => item.id !== activeView);

  return (
    <div className="app-shell">
      <main className={`main-column ${activeView === 'dashboard' ? 'dashboard-layout' : ''}`}>
        {activeView === 'upload' && (
          <header className="topbar">
            <div className="topbar-left">
              <h1 className="topbar-view-title">UPLOAD DE TRILHAS</h1>
            </div>
          </header>
        )}

        <section className="page-content">
          {activeView === 'upload' && (
            <div className="upload-action-row reveal">
              <nav className="quick-nav upload-action-nav" aria-label="Navegação principal">
                {visibleNavItems.map((item) => (
                  <button
                    key={item.id}
                    className={`nav-item ${activeView === item.id ? 'active' : ''}`}
                    aria-label={item.label}
                    onClick={() => onChangeView(item.id)}
                  >
                    {item.icon}
                    <span className="nav-item-label">{item.label}</span>
                  </button>
                ))}
              </nav>
            </div>
          )}

          {activeView === 'dashboard' && (
            <>
              <section className="hero-panel reveal">
                <div className="hero-media">
                  <img className="hero-banner-image" src={headerImage} alt="Trilhas Encante-se Personagens" />
                </div>
              </section>

              <div className="dashboard-toolbar reveal">
                <div className="search-field dashboard-search-field">
                  <Search size={16} />
                  <input
                    type="search"
                    placeholder="Pesquisar Trilha..."
                    value={searchTerm}
                    onChange={(event) => onSearchChange(event.target.value)}
                  />
                </div>
              </div>

              <div className="dashboard-action-row reveal">
                <nav className="quick-nav dashboard-action-nav" aria-label="Ações principais">
                  {visibleNavItems.map((item) => (
                    <button
                      key={item.id}
                      className={`nav-item ${activeView === item.id ? 'active' : ''}`}
                      aria-label={item.label}
                      onClick={() => onChangeView(item.id)}
                    >
                      {item.icon}
                      <span className="nav-item-label">{item.label}</span>
                    </button>
                  ))}
                </nav>
              </div>
            </>
          )}

          {children}
        </section>
      </main>
    </div>
  );
}
