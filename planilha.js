// ======================================================
// PLANILHAS: leitura de CSV e XLSX, e geração de XLSX
// Sem dependências externas (usa apenas o "zlib" do Node).
// ======================================================
const zlib = require("zlib");

const MAX_LINHAS = 20000;
const MAX_COLUNAS = 200;
const MAX_DESCOMPRIMIDO = 60 * 1024 * 1024; // proteção contra "zip bomb"

// ------------------------------------------------------
// CSV  ->  matriz (array de linhas, cada linha um array de textos)
// ------------------------------------------------------
function parseCsv(conteudo) {

    const texto = String(conteudo).replace(/^\uFEFF/, "");

    // Excel em português costuma salvar com ";" — descobre o separador pela primeira linha
    // (ignorando o que está entre aspas)
    let primeira = "";
    let aspas = false;

    for (const c of texto) {
        if (c === '"') aspas = !aspas;
        if (!aspas && (c === "\n" || c === "\r")) break;
        primeira += c;
    }

    const contar = sep => {
        let n = 0;
        let dentro = false;
        for (const c of primeira) {
            if (c === '"') dentro = !dentro;
            else if (c === sep && !dentro) n++;
        }
        return n;
    };

    const separador = [",", ";", "\t"].sort((a, b) => contar(b) - contar(a))[0];

    const linhas = [];
    let linha = [];
    let campo = "";
    let dentro = false;

    for (let i = 0; i < texto.length; i++) {

        const c = texto[i];

        if (dentro) {

            if (c === '"') {
                if (texto[i + 1] === '"') { campo += '"'; i++; }
                else dentro = false;
            } else {
                campo += c;
            }

            continue;
        }

        if (c === '"') {
            dentro = true;
        } else if (c === separador) {
            linha.push(campo);
            campo = "";
        } else if (c === "\n" || c === "\r") {

            if (c === "\r" && texto[i + 1] === "\n") i++;

            linha.push(campo);
            campo = "";
            linhas.push(linha);
            linha = [];

            if (linhas.length > MAX_LINHAS) break;

        } else {
            campo += c;
        }
    }

    if (campo !== "" || linha.length > 0) {
        linha.push(campo);
        linhas.push(linha);
    }

    return linhas;
}

// ------------------------------------------------------
// ZIP (leitura)
// ------------------------------------------------------
function lerZip(buf) {

    if (buf.length < 22) throw new Error("Arquivo inválido");

    // Procura o "fim do diretório central" a partir do final do arquivo
    let eocd = -1;

    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }

    if (eocd < 0) throw new Error("Não é um arquivo .xlsx válido");

    const total = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);

    const entradas = new Map();
    let acumulado = 0;

    for (let n = 0; n < total; n++) {

        if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("Arquivo corrompido");

        const metodo = buf.readUInt16LE(pos + 10);
        const tamComp = buf.readUInt32LE(pos + 20);
        const tamOrig = buf.readUInt32LE(pos + 24);
        const tamNome = buf.readUInt16LE(pos + 28);
        const tamExtra = buf.readUInt16LE(pos + 30);
        const tamComent = buf.readUInt16LE(pos + 32);
        const offset = buf.readUInt32LE(pos + 42);
        const nome = buf.toString("utf8", pos + 46, pos + 46 + tamNome);

        pos += 46 + tamNome + tamExtra + tamComent;

        acumulado += tamOrig;
        if (acumulado > MAX_DESCOMPRIMIDO) throw new Error("Arquivo grande demais");

        entradas.set(nome, { metodo, tamComp, tamOrig, offset });
    }

    return nome => {

        const e = entradas.get(nome);

        if (!e) return null;

        const inicio = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
        const dados = buf.subarray(inicio, inicio + e.tamComp);

        if (e.metodo === 0) return dados;

        if (e.metodo === 8) {
            return zlib.inflateRawSync(dados, { maxOutputLength: MAX_DESCOMPRIMIDO });
        }

        throw new Error("Compactação não suportada");
    };
}

// ------------------------------------------------------
// XLSX (leitura)  ->  [{ nome, linhas: matriz }]
// ------------------------------------------------------
const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodificarXml(t) {
    return String(t)
        .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
            if (e[0] === "#") {
                const cod = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                try { return String.fromCodePoint(cod); } catch { return ""; }
            }
            return ENTIDADES[e] ?? m;
        })
        .replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function textosDe(xml) {

    const sem = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let saida = "";

    for (const m of sem.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
        saida += decodificarXml(m[1] ?? "");
    }

    return saida;
}

const colunaDeRef = ref => {
    const letras = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "";
    let n = 0;
    for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
    return n - 1;
};

function numeroComoTexto(v) {

    // "5.8269856187E10" -> "58269856187" (o Excel usa notação científica em números grandes)
    if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(v)) {
        const n = Number(v);
        if (Number.isFinite(n)) {
            return n.toLocaleString("fullwide", { useGrouping: false, maximumFractionDigits: 10 });
        }
    }

    return v;
}

function lerXlsx(buf) {

    const ler = lerZip(buf);

    const arquivo = nome => {
        const d = ler(nome);
        return d ? d.toString("utf8").replace(/^\uFEFF/, "") : null;
    };

    const workbook = arquivo("xl/workbook.xml");

    if (!workbook) throw new Error("Não é um arquivo .xlsx válido");

    // relações: rId -> arquivo da aba
    const rels = new Map();
    const relsXml = arquivo("xl/_rels/workbook.xml.rels") || "";

    for (const m of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
        const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
        const alvo = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
        if (id && alvo) rels.set(id, alvo.replace(/^\/?(xl\/)?/, "xl/"));
    }

    // textos compartilhados
    const compartilhados = [];
    const ssXml = arquivo("xl/sharedStrings.xml");

    if (ssXml) {
        for (const m of ssXml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
            compartilhados.push(m[1] ? textosDe(m[1]) : "");
        }
    }

    const abas = [];
    let ordem = 0;

    for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {

        ordem++;

        const attrs = m[1];
        const nome = decodificarXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? `Aba ${ordem}`);
        const estado = /\bstate="([^"]*)"/.exec(attrs)?.[1];
        const rid = /\br:id="([^"]*)"/.exec(attrs)?.[1];

        if (estado === "hidden" || estado === "veryHidden") continue;

        const alvo = rels.get(rid) || `xl/worksheets/sheet${ordem}.xml`;
        const xml = arquivo(alvo);

        if (!xml) continue;

        abas.push({ nome, linhas: lerAba(xml, compartilhados) });
    }

    if (abas.length === 0) throw new Error("A planilha não tem abas visíveis");

    return abas;
}

function lerAba(xml, compartilhados) {

    const dados = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? "";
    const linhas = [];
    let linhaSeq = -1;

    for (const rm of dados.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {

        const rAttr = /\br="(\d+)"/.exec(rm[1])?.[1];
        const idxLinha = rAttr ? Number(rAttr) - 1 : linhaSeq + 1;

        linhaSeq = idxLinha;

        if (idxLinha >= MAX_LINHAS || !rm[2]) continue;

        let colSeq = -1;

        for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {

            const attrs = cm[1];
            const ref = /\br="([A-Za-z]+\d+)"/.exec(attrs)?.[1];
            const col = ref ? colunaDeRef(ref) : colSeq + 1;

            colSeq = col;

            if (col < 0 || col >= MAX_COLUNAS || !cm[2]) continue;

            const tipo = /\bt="([^"]*)"/.exec(attrs)?.[1];
            const corpo = cm[2];
            const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(corpo)?.[1];

            let valor = "";

            if (tipo === "s") valor = compartilhados[Number(v)] ?? "";
            else if (tipo === "inlineStr") valor = textosDe(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(corpo)?.[1] ?? "");
            else if (tipo === "str") valor = decodificarXml(v ?? "");
            else if (tipo === "b") valor = v === "1" ? "TRUE" : "FALSE";
            else if (tipo === "e") valor = "";
            else if (v !== undefined) valor = numeroComoTexto(decodificarXml(v).trim());

            if (!linhas[idxLinha]) linhas[idxLinha] = [];
            linhas[idxLinha][col] = valor;
        }
    }

    // preenche buracos
    const largura = linhas.reduce((m, l) => Math.max(m, l ? l.length : 0), 0);

    return Array.from({ length: linhas.length }, (_, i) => {
        const l = linhas[i] || [];
        return Array.from({ length: largura }, (_, c) => l[c] ?? "");
    });
}

// ------------------------------------------------------
// XLSX (geração)
// ------------------------------------------------------
const TABELA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function gerarZip(arquivos) {

    const partes = [];
    const central = [];
    let offset = 0;

    const agora = new Date();
    const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);
    const data = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();

    for (const { nome, dados } of arquivos) {

        const nomeBuf = Buffer.from(nome, "utf8");
        const comp = zlib.deflateRawSync(dados);
        const crc = crc32(dados);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(hora, 10);
        local.writeUInt16LE(data, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(dados.length, 22);
        local.writeUInt16LE(nomeBuf.length, 26);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0x0800, 8);
        cd.writeUInt16LE(8, 10);
        cd.writeUInt16LE(hora, 12);
        cd.writeUInt16LE(data, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(comp.length, 20);
        cd.writeUInt32LE(dados.length, 24);
        cd.writeUInt16LE(nomeBuf.length, 28);
        cd.writeUInt32LE(offset, 42);

        partes.push(local, nomeBuf, comp);
        central.push(cd, nomeBuf);

        offset += local.length + nomeBuf.length + comp.length;
    }

    const centralBuf = Buffer.concat(central);

    const fim = Buffer.alloc(22);
    fim.writeUInt32LE(0x06054b50, 0);
    fim.writeUInt16LE(arquivos.length, 8);
    fim.writeUInt16LE(arquivos.length, 10);
    fim.writeUInt32LE(centralBuf.length, 12);
    fim.writeUInt32LE(offset, 16);

    return Buffer.concat([...partes, centralBuf, fim]);
}

const escapar = t =>
    String(t)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

function letraColuna(i) {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    }
    return s;
}

// estilos: 0 normal | 1 cabeçalho | 2 texto com quebra de linha | 3 número 0.00 | 4 título | 5 cabeçalho de tabela de exemplo
const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF8B2D5B"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3E3EA"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// Uma aba: { nome, colunas: [{ titulo, largura }], linhas: [[...]], listas: [{ coluna, valores }],
//            estilos?: { "A1": 4 } , semCabecalho?: true }
// Valores: texto, número (vira número no Excel) ou { v, e } com estilo e.
function xmlAba(aba) {

    const linhasXml = [];
    const colunas = aba.colunas || [];
    const todas = aba.semCabecalho
        ? aba.linhas.map(l => l.map(v => (v && typeof v === "object" ? v : { v })))
        : [
            colunas.map(c => ({ v: c.titulo, e: 1 })),
            ...aba.linhas.map(l => l.map(v => (v && typeof v === "object" ? v : { v })))
        ];

    todas.forEach((linha, r) => {

        const celulas = [];

        linha.forEach(({ v, e }, c) => {

            if (v === null || v === undefined || v === "") return;

            const ref = letraColuna(c) + (r + 1);

            if (typeof v === "number" && Number.isFinite(v)) {
                celulas.push(`<c r="${ref}"${e !== undefined ? ` s="${e}"` : ""}><v>${v}</v></c>`);
            } else {
                celulas.push(
                    `<c r="${ref}" t="inlineStr"${e !== undefined ? ` s="${e}"` : ""}>` +
                    `<is><t xml:space="preserve">${escapar(v)}</t></is></c>`
                );
            }
        });

        const altura = !aba.semCabecalho && r === 0 ? ' ht="32" customHeight="1"' : "";

        linhasXml.push(`<row r="${r + 1}"${altura}>${celulas.join("")}</row>`);
    });

    const cols = colunas.length
        ? `<cols>${colunas.map((c, i) =>
            `<col min="${i + 1}" max="${i + 1}" width="${c.largura || 14}" customWidth="1"/>`).join("")}</cols>`
        : "";

    const congelar = !aba.semCabecalho
        ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

    const listas = (aba.listas || []).length
        ? `<dataValidations count="${aba.listas.length}">${aba.listas.map(l => {
            const col = letraColuna(l.coluna);
            return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" ` +
                `errorTitle="Valor inválido" error="Escolha um valor da lista." sqref="${col}2:${col}2000">` +
                `<formula1>${escapar('"' + l.valores.join(",") + '"')}</formula1></dataValidation>`;
        }).join("")}</dataValidations>`
        : "";

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${congelar}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${linhasXml.join("")}</sheetData>${listas}</worksheet>`;
}

function gerarXlsx(abas) {

    const nomes = abas.map((a, i) => escapar(a.nome || `Aba ${i + 1}`).slice(0, 31));

    const arquivos = [
        {
            nome: "[Content_Types].xml",
            dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${abas.map((_, i) =>
                `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`
        },
        {
            nome: "_rels/.rels",
            dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
        },
        {
            nome: "xl/workbook.xml",
            dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${nomes.map((n, i) =>
                `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`
        },
        {
            nome: "xl/_rels/workbook.xml.rels",
            dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${abas.map((_, i) =>
                `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
        },
        { nome: "xl/styles.xml", dados: ESTILOS },
        ...abas.map((a, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, dados: xmlAba(a) }))
    ].map(a => ({ nome: a.nome, dados: Buffer.from(a.dados, "utf8") }));

    return gerarZip(arquivos);
}

module.exports = { parseCsv, lerXlsx, gerarXlsx };
