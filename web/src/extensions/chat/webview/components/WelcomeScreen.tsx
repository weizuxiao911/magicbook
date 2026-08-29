import React from 'react';
import { getBrand, getSuggestions, formatBrand, type ChatSuggestion } from '../../scheme';

export const WelcomeScreen: React.FC<{
  onPick: (prompt: string) => void;
}> = ({ onPick }) => {
  const brand = getBrand();
  const suggestions: ChatSuggestion[] = getSuggestions().length
    ? getSuggestions(): [];
  return (
    <div className="chat__welcome">
      {brand && <div className="chat__welcome-logo">{brand.logo}</div>}
      {brand && <h1 className="chat__welcome-title">{formatBrand(brand.greeting, brand)}</h1>}
      {brand && <p className="chat__welcome-sub">{brand.subtitle}</p>}

      <div className="chat__welcome-suggest">
        {suggestions.map((s, i) => (
          <button key={i} className="chat__suggest" onClick={() => onPick(s.prompt)}>
            <span className="chat__suggest-icon">{s.icon}</span>
            <span className="chat__suggest-body">
              <span className="chat__suggest-title">{s.title}</span>
              <span className="chat__suggest-desc">{s.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};