import React from 'react';
import { getBrand, getSuggestions, formatBrand, type ChatSuggestion } from '../../scheme';

export const WelcomeScreen: React.FC<{
  onPick: (prompt: string) => void;
}> = ({ onPick }) => {
  const brand = getBrand();
  const suggestions: ChatSuggestion[] = getSuggestions().length
    ? getSuggestions()
    : [
        { icon: '🚀', title: '帮我完成一个任务', desc: '告诉我目标，拆解并执行', prompt: '帮我完成一个任务' },
        { icon: '🔍', title: '调研一个话题', desc: '检索资料并总结结论', prompt: '帮我调研一个话题，检索相关资料并给出结论' },
        { icon: '✍️', title: '撰写一份文档', desc: '方案 / 报告 / 邮件 / 文案', prompt: '帮我撰写一份文档' },
        { icon: '💡', title: '出个主意', desc: '头脑风暴与创意发散', prompt: '帮我出个主意，做一些头脑风暴与创意发散' },
      ];
  return (
    <div className="chat__welcome">
      {brand && <div className="chat__welcome-logo">{brand.logoChar}</div>}
      {brand && <h1 className="chat__welcome-title">{formatBrand(brand.greeting, brand)}</h1>}
      {brand && <p className="chat__welcome-sub">{brand.tagline}</p>}

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