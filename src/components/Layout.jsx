import React, { useState } from 'react';
import { Menu, Music, Search, Upload, X } from 'lucide-react';

export default function Layout({ children, searchTerm, onSearchChange, activeView, onChangeView }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems = [
    { id: 'dashboard', label: 'Trilhas Encante-se', icon: <Music size={18} /> },
    { id: 'upload', label: 'Upload de Trilhas', icon: <Upload size={18} /> },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar desktop-only">
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${activeView === item.id ? 'active' : ''}`}
              onClick={() => onChangeView(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

      </aside>

      <main className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="menu-toggle mobile-only" onClick={() => setMobileMenuOpen(true)}>
              <Menu size={20} />
            </button>

            {activeView === 'upload' ? (
              <h1 className="topbar-view-title">UPLOAD DE TRILHAS</h1>
            ) : (
              <div className="search-field">
                <Search size={16} />
                <input
                  type="search"
                  placeholder="Pesquisar Trilha..."
                  value={searchTerm}
                  onChange={(event) => onSearchChange(event.target.value)}
                />
              </div>
            )}
          </div>

        </header>

        <section className="page-content">{children}</section>
      </main>

      {mobileMenuOpen && (
        <div className="mobile-menu-overlay" role="dialog" aria-modal="true">
          <div className="mobile-menu">
            <div className="mobile-menu-header">
              <button className="icon-button" onClick={() => setMobileMenuOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <nav className="mobile-nav">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${activeView === item.id ? 'active' : ''}`}
                  onClick={() => {
                    onChangeView(item.id);
                    setMobileMenuOpen(false);
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}
