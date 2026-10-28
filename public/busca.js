// Busca do header: ao clicar mostra sugestões de termos; filtra enquanto digita.
(function () {
  "use strict";

  // Termos sugeridos (label) e palavras que cada um procura no nome/descrição dos produtos
  const TERMOS = [
    { label: "Camisetas / T-shirts", valor: "camiseta", chaves: ["camiseta", "t-shirt", "tshirt", "baby look"] },
    { label: "Shorts", valor: "shorts", chaves: ["short"] },
    { label: "Vestidos", valor: "vestido", chaves: ["vestido"] },
    { label: "Blusas", valor: "blusa", chaves: ["blusa", "regata", "cropped"] },
    { label: "Saias", valor: "saia", chaves: ["saia"] },
    { label: "Calças", valor: "calca", chaves: ["calca", "jeans", "legging"] },
    { label: "Conjuntos", valor: "conjunto", chaves: ["conjunto"] },
    { label: "Macacões", valor: "macacao", chaves: ["macacao", "macaquinho"] },
    { label: "Jaquetas e casacos", valor: "jaqueta", chaves: ["jaqueta", "casaco", "blazer"] }
  ];

  const campo = document.getElementById("campoBuscaHeader");
  const lista = document.getElementById("sugestoesBusca");
  if (!campo || !lista) return;
  const form = campo.form;

  const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

  let itens = [];
  let ativo = -1;

  function abrir(abre) {
    lista.hidden = !abre;
    campo.setAttribute("aria-expanded", String(abre));
    if (!abre) ativo = -1;
  }

  function desenhar() {
    const q = norm(campo.value);
    itens = TERMOS.filter(t => !q || norm(t.label).includes(q) || t.chaves.some(c => c.includes(q)));
    lista.innerHTML = "";

    if (!q) {
      const t = document.createElement("li");
      t.className = "sug-titulo";
      t.setAttribute("role", "presentation");
      t.textContent = "Buscas populares";
      lista.appendChild(t);
    }

    itens.forEach((t, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.id = "sug-" + i;
      li.textContent = t.label;
      li.addEventListener("mousedown", e => { e.preventDefault(); ir(t.valor); });
      lista.appendChild(li);
    });

    abrir(itens.length > 0 || !!q);
  }

  function marcar(i) {
    const opcoes = lista.querySelectorAll('[role="option"]');
    opcoes.forEach((o, n) => o.setAttribute("aria-selected", String(n === i)));
    ativo = i;
    if (opcoes[i]) {
      campo.setAttribute("aria-activedescendant", opcoes[i].id);
      opcoes[i].scrollIntoView({ block: "nearest" });
    }
  }

  function ir(termo) {
    const t = String(termo || "").trim();
    if (!t) return;
    location.href = "/?q=" + encodeURIComponent(t) + "#vitrine";
  }

  campo.addEventListener("focus", desenhar);
  campo.addEventListener("click", desenhar);
  campo.addEventListener("input", desenhar);

  campo.addEventListener("keydown", e => {
    const n = lista.querySelectorAll('[role="option"]').length;
    if (e.key === "ArrowDown") { e.preventDefault(); if (lista.hidden) desenhar(); marcar((ativo + 1) % Math.max(n, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); marcar((ativo - 1 + n) % Math.max(n, 1)); }
    else if (e.key === "Escape") abrir(false);
    else if (e.key === "Enter" && ativo >= 0 && itens[ativo]) { e.preventDefault(); ir(itens[ativo].valor); }
  });

  form.addEventListener("submit", e => { e.preventDefault(); ir(campo.value); });

  document.addEventListener("click", e => { if (!form.contains(e.target)) abrir(false); });

  // O filtro da vitrine é feito pelo produtos.js (parâmetro ?q=). Aqui só preenchemos o campo.
  const q = new URLSearchParams(location.search).get("q");
  if (q) campo.value = q;
})();