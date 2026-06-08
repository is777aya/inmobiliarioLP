// Variables globales
let map;
let puntosLayer, zonasLayer, macrosLayer;
let puntosGeoJSON = null;
let zonasGeoJSON = null;
let macrosGeoJSON = null;
let precioMinGlobal, precioMaxGlobal;
let colorScheme = 'quantile';
let currentFeatures = [];

// Función para calcular radio del círculo según precio y zoom
function getRadius(precio, zoom) {
    if (precio <= 0) return 3;
    const baseZoom = 12;
    const factorZoom = 1 + (zoom - baseZoom) * 0.08;
    const precioEnMillones = precio / 1000000;
    let radius = Math.pow(precioEnMillones, 0.35) * 6;
    radius = Math.min(22, Math.max(4, radius));
    radius = radius * factorZoom;
    return Math.min(28, Math.max(3, radius));
}

// Obtener color según tercil (3 categorías)
function getQuantileColor(precio, preciosArray) {
    if (!preciosArray.length) return '#f97316';
    const sorted = [...preciosArray].sort((a,b) => a-b);
    const count = sorted.length;
    const t1 = sorted[Math.floor(count * 1/3)];
    const t2 = sorted[Math.floor(count * 2/3)];
    if (precio <= t1) return '#1899de';
    if (precio <= t2) return '#fee08b';
    return '#df0d0d';
}

function updateLegend() {
    const legendDiv = document.getElementById('legend');
    legendDiv.style.display = (colorScheme === 'quantile') ? 'block' : 'none';
}

function recolorPuntos() {
    if (!puntosLayer) return;
    const zoom = map.getZoom();
    if (colorScheme === 'single') {
        puntosLayer.eachLayer(layer => {
            const precio = layer.feature.properties.precio_pre;
            const radius = getRadius(precio, zoom);
            layer.setStyle({
                fillColor: '#f97316',
                color: '#ffc857',
                fillOpacity: 0.7,
                opacity: 0.9,
                radius: radius
            });
            if (layer.setRadius) layer.setRadius(radius);
        });
    } else {
        const precios = currentFeatures.map(f => f.properties.precio_pre).filter(p => p > 0);
        puntosLayer.eachLayer(layer => {
            const precio = layer.feature.properties.precio_pre;
            const radius = getRadius(precio, zoom);
            const color = getQuantileColor(precio, precios);
            layer.setStyle({
                fillColor: color,
                color: '#ffffff',
                fillOpacity: 0.8,
                opacity: 0.9,
                radius: radius
            });
            if (layer.setRadius) layer.setRadius(radius);
        });
    }
}

function updateRadii() {
    if (!puntosLayer || !puntosLayer._map) return;
    const zoom = map.getZoom();
    puntosLayer.eachLayer(layer => {
        const precio = layer.feature.properties.precio_pre;
        const radius = getRadius(precio, zoom);
        layer.setRadius(radius);
        if (colorScheme === 'single') {
            layer.setStyle({ fillColor: '#f97316', color: '#ffc857' });
        }
    });
}

function setLayerOpacity(layer, percent) {
    if (!layer) return;
    const opacity = percent / 100;
    layer.setStyle({
        fillOpacity: opacity * 0.5,
        opacity: opacity * 0.8
    });
}

function setPuntosOpacity(percent) {
    if (!puntosLayer) return;
    const opacity = percent / 100;
    puntosLayer.eachLayer(layer => {
        if (layer.setStyle) {
            layer.setStyle({
                fillOpacity: opacity,
                opacity: opacity * 0.9
            });
        } else {
            layer.options.fillOpacity = opacity;
            layer.options.opacity = opacity * 0.9;
            if (layer._path) {
                layer._path.style.fillOpacity = opacity;
                layer._path.style.strokeOpacity = opacity * 0.9;
            }
        }
    });
}

// Función auxiliar para obtener el rango de precios de puntos que cumplen filtros espaciales (sin aplicar filtro de precio)
function getPriceRangeBySpatialFilters() {
    const macroSeleccionado = document.getElementById('macro-select').value;
    const zonaSeleccionada = document.getElementById('zone-select').value;
    if (!puntosGeoJSON) return null;

    let features = puntosGeoJSON.features.filter(f => f.properties.precio_pre > 0);

    if (macroSeleccionado !== 'all' && macrosGeoJSON) {
        const macroFeature = macrosGeoJSON.features.find(f => f.properties.macro_ante === macroSeleccionado);
        if (macroFeature) {
            const polygon = turf.polygon(macroFeature.geometry.coordinates);
            features = features.filter(f => {
                const point = turf.point(f.geometry.coordinates);
                return turf.booleanPointInPolygon(point, polygon);
            });
        }
    }

    if (zonaSeleccionada !== 'all' && zonasGeoJSON) {
        const zonaFeature = zonasGeoJSON.features.find(f => f.properties.GDBSNOMB === zonaSeleccionada);
        if (zonaFeature) {
            const polygon = turf.polygon(zonaFeature.geometry.coordinates);
            features = features.filter(f => {
                const point = turf.point(f.geometry.coordinates);
                return turf.booleanPointInPolygon(point, polygon);
            });
        }
    }

    const prices = features.map(f => f.properties.precio_pre).filter(p => p > 0);
    if (prices.length === 0) return null;
    return { min: Math.min(...prices), max: Math.max(...prices) };
}

// Actualizar slider de rango con nuevos valores (sin disparar evento slide)
function updateSliderRange(minVal, maxVal, preserveCurrent = true) {
    const currentMin = $("#price-slider").slider("values")[0];
    const currentMax = $("#price-slider").slider("values")[1];
    let newMin = minVal;
    let newMax = maxVal;
    if (preserveCurrent) {
        // Ajustar valores actuales al nuevo rango (clamp)
        newMin = Math.max(minVal, Math.min(currentMin, maxVal));
        newMax = Math.min(maxVal, Math.max(currentMax, minVal));
    }
    $("#price-slider").slider("option", "min", minVal);
    $("#price-slider").slider("option", "max", maxVal);
    $("#price-slider").slider("values", [newMin, newMax]);
    $("#min-price-label").text(Math.round(newMin).toLocaleString());
    $("#max-price-label").text(Math.round(newMax).toLocaleString());
    return { min: newMin, max: newMax };
}

// Función principal de filtrado (combina macrodistrito, zona y rango de precio)
function filterPoints() {
    const minPrice = $("#price-slider").slider("values")[0];
    const maxPrice = $("#price-slider").slider("values")[1];
    const macroSeleccionado = document.getElementById('macro-select').value;
    const zonaSeleccionada = document.getElementById('zone-select').value;

    if (!puntosGeoJSON) return;

    let features = puntosGeoJSON.features.filter(f => {
        const price = f.properties.precio_pre;
        return price > 0 && price >= minPrice && price <= maxPrice;
    });

    if (macroSeleccionado !== 'all' && macrosGeoJSON) {
        const macroFeature = macrosGeoJSON.features.find(f => f.properties.macro_ante === macroSeleccionado);
        if (macroFeature) {
            const polygon = turf.polygon(macroFeature.geometry.coordinates);
            features = features.filter(f => {
                const point = turf.point(f.geometry.coordinates);
                return turf.booleanPointInPolygon(point, polygon);
            });
        }
    }

    if (zonaSeleccionada !== 'all' && zonasGeoJSON) {
        const zonaFeature = zonasGeoJSON.features.find(f => f.properties.GDBSNOMB === zonaSeleccionada);
        if (zonaFeature) {
            const polygon = turf.polygon(zonaFeature.geometry.coordinates);
            features = features.filter(f => {
                const point = turf.point(f.geometry.coordinates);
                return turf.booleanPointInPolygon(point, polygon);
            });
        }
    }

    currentFeatures = features;
    const currentPuntosOpacity = document.getElementById('opacity-puntos').value;

    if (puntosLayer) map.removeLayer(puntosLayer);

    puntosLayer = L.geoJSON(features, {
        pointToLayer: (feature, latlng) => {
            const precio = feature.properties.precio_pre;
            const zoom = map.getZoom();
            const radius = (precio > 0) ? getRadius(precio, zoom) : 3;
            return L.circleMarker(latlng, {
                radius: radius,
                fillColor: '#f97316',
                color: '#ffc857',
                weight: 1,
                fillOpacity: 0.7,
                opacity: 0.9
            });
        },
        onEachFeature: (feature, layer) => {
            const precio = feature.properties.precio_pre;
            if (precio > 0) {
                layer.bindTooltip(`$${Math.round(precio).toLocaleString()} USD`, { sticky: true, direction: 'top' });
            } else {
                layer.bindTooltip(`Precio atípico`, { sticky: true });
            }
        }
    }).addTo(map);
    setPuntosOpacity(currentPuntosOpacity);
    recolorPuntos();

    const prices = features.map(f => f.properties.precio_pre).filter(p => p > 0);
    const count = prices.length;
    const avg = count ? prices.reduce((a,b) => a+b,0) / count : 0;
    const minP = count ? Math.min(...prices) : 0;
    const maxP = count ? Math.max(...prices) : 0;
    document.getElementById('points-count').innerText = count;
    document.getElementById('avg-price').innerText = Math.round(avg).toLocaleString();
    document.getElementById('range-price').innerText = count ? `${Math.round(minP).toLocaleString()} - ${Math.round(maxP).toLocaleString()}` : '-';

    if (macrosLayer) {
        macrosLayer.eachLayer(layer => {
            const nombre = layer.feature.properties.macro_ante;
            if (macroSeleccionado !== 'all' && nombre === macroSeleccionado) {
                layer.setStyle({ color: '#00aa00', weight: 3, fillOpacity: 0.5 });
                map.fitBounds(layer.getBounds());
            } else {
                layer.setStyle({ color: '#006400', weight: 2, fillOpacity: 0.17, dashArray: '3' });
            }
        });
    }

    if (zonasLayer) {
        zonasLayer.eachLayer(layer => {
            const nombre = layer.feature.properties.GDBSNOMB;
            if (zonaSeleccionada !== 'all' && nombre === zonaSeleccionada) {
                layer.setStyle({ color: '#ff4444', weight: 3, fillOpacity: 0.6 });
                if (macroSeleccionado === 'all') map.fitBounds(layer.getBounds());
            } else {
                layer.setStyle({ color: '#8B0000', weight: 2, fillOpacity: 0.20, dashArray: '3' });
            }
        });
    }
    
    // Asegurar que las zonas queden por encima de los macrodistritos
    if (zonasLayer) zonasLayer.bringToFront();
    if (puntosLayer) puntosLayer.bringToFront();
}

// Actualizar slider basado en filtros espaciales (macro/zona) sin aplicar filtro de precio aún
function updateSliderFromSpatialFilters() {
    const range = getPriceRangeBySpatialFilters();
    if (range) {
        // Actualizar el slider al nuevo rango, preservando la selección actual dentro de lo posible
        updateSliderRange(range.min, range.max, true);
    }
}

// Wrapper para cambios que deben actualizar tanto el slider como los puntos
function onSpatialFilterChange() {
    updateSliderFromSpatialFilters();
    filterPoints();
}

async function init() {
    const [puntosResp, zonasResp, macrosResp] = await Promise.all([
        fetch('puntos.geojson'),
        fetch('zonas.geojson'),
        fetch('macrodistritos.geojson')
    ]);
    puntosGeoJSON = await puntosResp.json();
    zonasGeoJSON = await zonasResp.json();
    macrosGeoJSON = await macrosResp.json();

    const preciosGlobales = puntosGeoJSON.features.map(f => f.properties.precio_pre).filter(p => p > 0);
    if (preciosGlobales.length === 0) {
        alert("No hay puntos con precios positivos. Verifica los datos.");
        return;
    }
    precioMinGlobal = Math.min(...preciosGlobales);
    precioMaxGlobal = Math.max(...preciosGlobales);

    // Configurar slider inicial con rango global
    $("#price-slider").slider({
        range: true,
        min: precioMinGlobal,
        max: precioMaxGlobal,
        values: [precioMinGlobal, precioMaxGlobal],
        slide: function(event, ui) {
            $("#min-price-label").text(Math.round(ui.values[0]).toLocaleString());
            $("#max-price-label").text(Math.round(ui.values[1]).toLocaleString());
            filterPoints();   // aplicar filtro de precio sobre el estado actual
        }
    });
    $("#min-price-label").text(Math.round(precioMinGlobal).toLocaleString());
    $("#max-price-label").text(Math.round(precioMaxGlobal).toLocaleString());

    map = L.map('map').setView([-16.5106, -68.0801], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // Capa de macrodistritos
    macrosLayer = L.geoJSON(macrosGeoJSON, {
        style: { color: '#006400', weight: 2, fillOpacity: 0.05, dashArray: '3' },
        onEachFeature: (feature, layer) => {
            const nombre = feature.properties.macro_ante || 'Macrodistrito';
            layer.bindTooltip(nombre, { sticky: true });
        }
    }).addTo(map);
    setLayerOpacity(macrosLayer, 30);

    // Capa de zonas (por encima de macrodistritos)
    zonasLayer = L.geoJSON(zonasGeoJSON, {
        style: { color: '#8B0000', weight: 2, fillOpacity: 0.08, dashArray: '3' },
        onEachFeature: (feature, layer) => {
            const nombre = feature.properties.GDBSNOMB || 'Zona';
            layer.bindTooltip(nombre, { sticky: true });
        }
    }).addTo(map);
    setLayerOpacity(zonasLayer, 20);
    zonasLayer.bringToFront();

    // Rellenar selectores
    const macroSelect = document.getElementById('macro-select');
    const macrosNombres = [...new Set(macrosGeoJSON.features.map(f => f.properties.macro_ante))].filter(Boolean).sort();
    macrosNombres.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        macroSelect.appendChild(opt);
    });

    const zoneSelect = document.getElementById('zone-select');
    const zonasNombres = [...new Set(zonasGeoJSON.features.map(f => f.properties.GDBSNOMB))].filter(Boolean).sort();
    zonasNombres.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        zoneSelect.appendChild(opt);
    });

    // Selector de esquema de color
    const colorSelect = document.getElementById('color-scheme');
    colorScheme = colorSelect.value;
    colorSelect.addEventListener('change', (e) => {
        colorScheme = e.target.value;
        updateLegend();
        if (puntosLayer) recolorPuntos();
    });

    // Filtros espaciales: al cambiar macro o zona, primero ajustamos el slider y luego filtramos puntos
    macroSelect.addEventListener('change', () => {
        onSpatialFilterChange();
    });
    zoneSelect.addEventListener('change', () => {
        onSpatialFilterChange();
    });

    // Botón reset: restablece macro y zona a "all" y slider a rango global
    document.getElementById('reset-btn').addEventListener('click', () => {
        document.getElementById('macro-select').value = 'all';
        document.getElementById('zone-select').value = 'all';
        // Actualizar slider al rango global completo
        updateSliderRange(precioMinGlobal, precioMaxGlobal, false);
        filterPoints();  // filtrará todos los puntos sin restricción espacial
    });

    // Inicializar puntos
    filterPoints();
    updateLegend();

    map.on('zoomend', () => updateRadii());

    // Controles de capas (igual que antes, con bringToFront cuando se activan)
    const toggleMacros = document.getElementById('toggle-macros');
    const opacityMacros = document.getElementById('opacity-macros');
    const opacityMacrosVal = document.getElementById('opacity-macros-val');
    toggleMacros.addEventListener('change', () => {
        if (toggleMacros.checked) {
            if (macrosLayer && !map.hasLayer(macrosLayer)) map.addLayer(macrosLayer);
        } else {
            if (macrosLayer && map.hasLayer(macrosLayer)) map.removeLayer(macrosLayer);
        }
        if (toggleMacros.checked && zonasLayer) zonasLayer.bringToFront();
        if (puntosLayer) puntosLayer.bringToFront();
    });
    opacityMacros.addEventListener('input', () => {
        const val = opacityMacros.value;
        opacityMacrosVal.innerText = `${val}%`;
        if (macrosLayer && map.hasLayer(macrosLayer)) setLayerOpacity(macrosLayer, val);
    });

    const toggleZonas = document.getElementById('toggle-zonas');
    const opacityZonas = document.getElementById('opacity-zonas');
    const opacityZonasVal = document.getElementById('opacity-zonas-val');
    toggleZonas.addEventListener('change', () => {
        if (toggleZonas.checked) {
            if (zonasLayer && !map.hasLayer(zonasLayer)) map.addLayer(zonasLayer);
        } else {
            if (zonasLayer && map.hasLayer(zonasLayer)) map.removeLayer(zonasLayer);
        }
        if (toggleZonas.checked) zonasLayer.bringToFront();
        if (puntosLayer) puntosLayer.bringToFront();
    });
    opacityZonas.addEventListener('input', () => {
        const val = opacityZonas.value;
        opacityZonasVal.innerText = `${val}%`;
        if (zonasLayer && map.hasLayer(zonasLayer)) setLayerOpacity(zonasLayer, val);
    });

    const togglePuntos = document.getElementById('toggle-puntos');
    const opacityPuntos = document.getElementById('opacity-puntos');
    const opacityPuntosVal = document.getElementById('opacity-puntos-val');
    togglePuntos.addEventListener('change', () => {
        if (togglePuntos.checked) {
            if (puntosLayer && !map.hasLayer(puntosLayer)) {
                map.addLayer(puntosLayer);
                updateRadii();
            }
        } else {
            if (puntosLayer && map.hasLayer(puntosLayer)) map.removeLayer(puntosLayer);
        }
        if (puntosLayer) puntosLayer.bringToFront();
    });
    opacityPuntos.addEventListener('input', () => {
        const val = opacityPuntos.value;
        opacityPuntosVal.innerText = `${val}%`;
        if (puntosLayer && map.hasLayer(puntosLayer)) setPuntosOpacity(val);
    });
}

window.addEventListener('load', () => {
    if (typeof turf !== 'undefined' && typeof $ !== 'undefined') {
        init();
    } else {
        console.error("No se cargaron las dependencias (jQuery o Turf)");
    }
});
