// These bits are from torus.js
const HTML_IDL_ATTRIBUTES = [
    'type',
    'value',
    'selected',
    'indeterminate',
    'tabIndex',
    'checked',
    'disabled',
];

const arrayNormalize = data => Array.isArray(data) ? data : [data];

const normalizeJDOM = jdom => {
    if (!('attrs' in jdom)) jdom.attrs = {};
    if (!('events' in jdom)) jdom.events = {};
    if (!('children' in jdom)) jdom.children = [];
    return jdom;
}

// This string renderer is a drop-in replacement for renderJDOM
//  in torus.js, if we want Torus components to render to an HTML
//  string in a server-side-rendering context.
// But while it is API compatible with renderJDOM and capable of
//  rendering full JDOM, the design of Torus itself isn't optimized
//  for use outside of the browser (Torus depends on DOM APIs).
//  As a result, SSR is still a story in progress for Torus.

const stringRenderJDOM = (_node, _previous, next) => {

    let node = '';

    if (next === null) {
        node = '<!-- -->';
    } else if (typeof next === 'string' || typeof next === 'number') {
        node = next.toString();
    } else if (typeof next === 'object') {
        normalizeJDOM(next);

        let attrs = [],
            styles = [],
            classes = [],
            children = [];

        for (const attrName in next.attrs) {
            switch (attrName) {
                case 'class':
                    classes = arrayNormalize(next.attrs.class);
                    break;
                case 'style':
                    for (const [styleKey, styleValue] of next.attrs.style) {
                        styles.push(styleKey + ' ' + styleValue);
                    }
                    break;
                default:
                    if (HTML_IDL_ATTRIBUTES.includes(attrName)) {
                        if (next.attrs[attrName] === true) {
                            attrs.push(attrName);
                        }
                    } else {
                        attrs.push(`${attrName}="${next.attrs[attrName]}"`);
                    }
            }
        }
        for (const child of next.children) {
            children.push(stringRenderJDOM(undefined, undefined, child));
        }

        node = `<${next.tag} ${attrs.join(' ')}
            style="${styles.join(';')}" class="${classes.join(' ')}">
                ${children.join('')}
        </${next.tag}>`;
    }

    return node.replace(/\s+/g, ' ');
}

module.exports = stringRenderJDOM;
