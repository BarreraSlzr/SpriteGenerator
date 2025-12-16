import { Check, Code, Copy, Database, Download, Grid, Layers, RefreshCw, Tag, Trash2, Upload, Wand2, Zap, Share2, Scissors } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

// --- Lightweight IndexedDB Wrapper ---
// This handles saving binary Blobs and JSON state without external dependencies
const DB_NAME = 'sprite_builder_db';
const DB_VERSION = 1;

const db = {
  open: () => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('session')) {
          db.createObjectStore('session'); // For metadata (sprites, config)
        }
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images'); // For binary blobs
        }
      };
    });
  },
  put: async (storeName, key, value) => {
    const database = await db.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(value, key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  get: async (storeName, key) => {
    const database = await db.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  clear: async () => {
    const database = await db.open();
    const tx = database.transaction(['session', 'images'], 'readwrite');
    tx.objectStore('session').clear();
    tx.objectStore('images').clear();
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve();
    });
  }
};

const App = () => {
  // Mode: 'analyze' (single large image) or 'build' (pasting multiple small images)
  const [mode, setAppMode] = useState('analyze');

  // Shared State
  const [imageSrc, setImageSrc] = useState(null); // The final composite (Blob URL)
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });
  const [sprites, setSprites] = useState([]);
  const [selectedSpriteId, setSelectedSpriteId] = useState(null);
  const [codeMode, setCodeMode] = useState('scss'); // css, scss, json
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);

  // Builder Mode State (individual raw images)
  // Note: We don't persist these raw source images in this demo to keep DB small, 
  // we primarily persist the *Composite* result and metadata.
  const [buildItems, setBuildItems] = useState([]);

  // Drawing State (Analyze Mode)
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState(null);

  // Grid Config (Analyze Mode)
  const [gridConfig, setGridConfig] = useState({ rows: 4, cols: 4, padding: 0 });
  const [showGridModal, setShowGridModal] = useState(false);

  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const saveTimeoutRef = useRef(null);

  // --- 1. Load from DB on Mount ---
  useEffect(() => {
    const loadSession = async () => {
      try {
        const metadata = await db.get('session', 'meta');
        const blob = await db.get('images', 'composite');

        if (metadata && blob) {
          // Restore Metadata
          setAppMode(metadata.mode);
          setSprites(metadata.sprites || []);
          setBuildItems(metadata.buildItems || []);
          setImageDimensions(metadata.dimensions || { width: 0, height: 0 });

          // Restore Blob
          const url = URL.createObjectURL(blob);
          setImageSrc(url);
          setLastSaved(new Date());
          console.log('Restored session from IndexedDB');
        }
      } catch (err) {
        console.error('Failed to load session:', err);
      }
    };
    loadSession();
  }, []);

  // --- 2. Auto-Save Logic ---
  const triggerSave = useCallback(async (currentSprites, currentBuildItems, currentDim, currentMode, currentBlob) => {
    setIsSaving(true);
    try {
      // Save Metadata
      await db.put('session', 'meta', {
        sprites: currentSprites,
        buildItems: currentBuildItems.map(i => ({ ...i, imgElement: null })), // Don't save circular refs/DOM elements
        dimensions: currentDim,
        mode: currentMode,
        timestamp: Date.now()
      });

      // Save Binary Data (if provided)
      if (currentBlob) {
        await db.put('images', 'composite', currentBlob);
      }

      setLastSaved(new Date());
      setIsSaving(false);
    } catch (err) {
      console.error('Save failed', err);
      setIsSaving(false);
    }
  }, []);

  // Debounced Save Effect
  useEffect(() => {
    if (!imageSrc) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(() => {
      // We fetch the blob from the current URL to ensure we save what's on screen
      // Note: In a real app, we might pass the blob directly from drawComposite to avoid fetching
      fetch(imageSrc).then(r => r.blob()).then(blob => {
        triggerSave(sprites, buildItems, imageDimensions, mode, blob);
      });
    }, 2000); // Auto-save every 2s of inactivity

    return () => clearTimeout(saveTimeoutRef.current);
  }, [sprites, buildItems, imageDimensions, mode, imageSrc, triggerSave]);


  // --- Layout Engine for Builder Mode ---
  const repackSprites = (items) => {
    if (items.length === 0) return;

    // Simple layout algorithm: Row-based packing
    const totalArea = items.reduce((acc, item) => acc + (item.w * item.h), 0);
    const roughWidth = Math.max(512, Math.sqrt(totalArea) * 1.5);
    const maxWidth = Math.min(4096, roughWidth);

    let currentX = 0;
    let currentY = 0;
    let rowHeight = 0;
    let maxCanvasWidth = 0;
    const padding = 2; // pixel padding to prevent bleed

    const positionedItems = items.map(item => {
      // Check if we need to wrap
      if (currentX + item.w > maxWidth && currentX > 0) {
        currentX = 0;
        currentY += rowHeight + padding;
        rowHeight = 0;
      }

      const pos = { ...item, x: currentX, y: currentY };

      // Update cursors
      currentX += item.w + padding;
      rowHeight = Math.max(rowHeight, item.h);
      maxCanvasWidth = Math.max(maxCanvasWidth, currentX);

      return pos;
    });

    const finalWidth = maxCanvasWidth;
    const finalHeight = currentY + rowHeight;

    setImageDimensions({ width: finalWidth, height: finalHeight });

    // Update Sprites (Coordinates)
    const newSprites = positionedItems.map(item => ({
      id: item.id,
      name: item.tag || item.name,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h
    }));
    setSprites(newSprites);

    // Draw Composite Image using Binary Data (Blobs)
    // Small delay to let state settle
    setTimeout(() => drawComposite(positionedItems, finalWidth, finalHeight), 10);
  };

  const drawComposite = (items, width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });

    ctx.clearRect(0, 0, width, height);

    let itemsLoaded = 0;
    const totalItems = items.length;

    // Helper to finish drawing
    const finish = () => {
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          if (imageSrc && imageSrc.startsWith('blob:')) {
            URL.revokeObjectURL(imageSrc);
          }
          setImageSrc(url);
          // Trigger immediate save of new blob
          triggerSave(sprites, buildItems, { width, height }, mode, blob);
        }
      }, 'image/png');
    };

    items.forEach(item => {
      if (item.imgElement) {
        ctx.drawImage(item.imgElement, item.x, item.y, item.w, item.h);
        itemsLoaded++;
        if (itemsLoaded === totalItems) finish();
      } else if (item.originalSrc) {
        // Re-hydrate image if it was lost (e.g. from JSON state)
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, item.x, item.y, item.w, item.h);
          itemsLoaded++;
          if (itemsLoaded === totalItems) finish();
        }
        img.src = item.originalSrc;
      }
    });

    // If we have items but they are already "drawn" conceptually or we are in restore mode without raw images,
    // we might need to rely on the restored 'composite' blob.
    // However, for this specific 'repack' function, we assume we have valid items.
    if (totalItems === 0) finish();
  };

  // --- Update Tag Name ---
  const handleTagChange = (id, newTag) => {
    const cleanTag = newTag.replace(/[^a-zA-Z0-9-_]/g, '-');

    const updatedBuildItems = buildItems.map(item =>
      item.id === id ? { ...item, tag: cleanTag, name: cleanTag } : item
    );
    setBuildItems(updatedBuildItems);

    const updatedSprites = sprites.map(s =>
      s.id === id ? { ...s, name: cleanTag } : s
    );
    setSprites(updatedSprites);
  };

  // --- Serialization Logic ---
  const serializeSprites = (spritesToSerialize) => {
    // Format: v1|name:x,y,w,h;name2:x,y,w,h
    if (!spritesToSerialize || spritesToSerialize.length === 0) return '';
    const data = spritesToSerialize.map(s => {
      // Ensure no reserved chars in name for safety, though replace logic exists elsewhere
      const cleanName = s.name.replace(/[:;,|]/g, '-');
      return `${cleanName}:${s.x},${s.y},${s.w},${s.h}`;
    }).join(';');
    return `v1|${data}`;
  };

  const deserializeSprites = (hash) => {
    if (!hash || !hash.startsWith('#')) return [];
    const content = hash.slice(1); // remove #
    if (!content.startsWith('v1|')) return []; // Basic version check

    const dataStr = content.substring(3); // remove v1|
    if (!dataStr) return [];

    const items = dataStr.split(';');
    return items.map((item, index) => {
      const [name, coords] = item.split(':');
      if (!name || !coords) return null;

      const [x, y, w, h] = coords.split(',').map(Number);
      if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return null;

      return {
        id: Date.now() + index, // New dummy ID
        name: name,
        x, y, w, h
      };
    }).filter(Boolean);
  };

  // --- Load from URL Hash on Mount ---
  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const loadedSprites = deserializeSprites(hash);
      if (loadedSprites.length > 0) {
        setSprites(loadedSprites);
        console.log('Restored sprites from URL hash');
        // If we loaded from URL, we might want to ensure we are in analyze mode 
        // effectively, though we might verify if we have an image.
        // For now, we trust the existing image loading logic or the user to upload one.
      }
    }
  }, []); // Run once on mount

  // Update URL when sprites change (Optional: specific user action might be better to avoid history spam)
  const handleShareUrl = () => {
    const hash = serializeSprites(sprites);
    window.location.hash = hash;
    navigator.clipboard.writeText(window.location.href);
    alert('URL copied to clipboard!');
  };


  // --- Paste Handler ---
  useEffect(() => {
    const handlePaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();

          createImageBitmap(blob).then((imageBitmap) => {
            // SMART PASTE: If we have sprites but no image, treat this as a BACKGROUND RESTORE
            if (!imageSrc && sprites.length > 0) {
              setAppMode('analyze');
              const url = URL.createObjectURL(blob);
              const img = new Image();
              img.onload = () => {
                setImageDimensions({ width: img.width, height: img.height });
                setImageSrc(url);
                // Trigger save, preserving existing sprites
                triggerSave(sprites, [], { width: img.width, height: img.height }, 'analyze', blob);
              };
              img.src = url;
              return; // Stop here, don't add as a build item
            }

            // Default Behavior: Add as new Build Item
            if (mode === 'analyze') {
              setAppMode('build');
            }

            const defaultTag = `sprite-${buildItems.length + sprites.length + 1}`;

            const img = new Image();
            img.src = URL.createObjectURL(blob);
            img.onload = () => {
              const newItem = {
                id: Date.now() + Math.random(),
                name: defaultTag,
                tag: defaultTag,
                w: img.width,
                h: img.height,
                imgElement: img,
                originalSrc: img.src
              };

              setBuildItems(prev => {
                const updated = [...prev, newItem];
                repackSprites(updated);
                return updated;
              });
            }
          });
          e.preventDefault();
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [buildItems, mode, imageSrc, sprites, triggerSave]); // Added sprites to dep array

  // Handle Manual Upload
  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setAppMode('analyze');
      setBuildItems([]);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        setImageDimensions({ width: img.width, height: img.height });
        setImageSrc(url);
        // SMART UPLOAD: If sprites exist, keep them (Reset clears them if needed)
        // setSprites([]); <--- REMOVED THIS LINE
        setZoom(1);
        // Trigger save
        triggerSave(sprites, [], { width: img.width, height: img.height }, 'analyze', file);
      };
      img.src = url;
    }
  };

  // --- Canvas Interaction ---
  const getMousePos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom
    };
  };

  const handleMouseDown = (e) => {
    if (!imageSrc || mode === 'build') return;
    const pos = getMousePos(e);
    setIsDrawing(true);
    setStartPos(pos);
    setSelectedSpriteId(null);
  };

  const handleMouseMove = (e) => {
    if (!isDrawing || mode === 'build') return;
    const pos = getMousePos(e);
    setCurrentRect({
      x: Math.min(startPos.x, pos.x),
      y: Math.min(startPos.y, pos.y),
      w: Math.abs(pos.x - startPos.x),
      h: Math.abs(pos.y - startPos.y)
    });
  };

  const handleMouseUp = () => {
    if (!isDrawing || !currentRect || mode === 'build') return;
    if (currentRect.w > 5 && currentRect.h > 5) {
      const newSprite = {
        id: Date.now(),
        name: `sprite-${sprites.length + 1}`,
        x: Math.round(currentRect.x),
        y: Math.round(currentRect.y),
        w: Math.round(currentRect.w),
        h: Math.round(currentRect.h)
      };
      setSprites([...sprites, newSprite]);
      setSelectedSpriteId(newSprite.id);
    }
    setIsDrawing(false);
    setCurrentRect(null);
  };

  const generateGrid = () => {
    if (!imageDimensions.width) return;
    const { rows, cols, padding } = gridConfig;
    const itemWidth = (imageDimensions.width - (padding * (cols + 1))) / cols;
    const itemHeight = (imageDimensions.height - (padding * (rows + 1))) / rows;

    const newSprites = [];
    let count = 1;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        newSprites.push({
          id: Date.now() + count,
          name: `icon-${count}`,
          x: Math.round(padding + (c * (itemWidth + padding))),
          y: Math.round(padding + (r * (itemHeight + padding))),
          w: Math.round(itemWidth),
          h: Math.round(itemHeight)
        });
        count++;
      }
    }
    setSprites(newSprites);
    setShowGridModal(false);
  };

  // --- Canvas Rendering Loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageSrc) return;

    const ctx = canvas.getContext('2d');
    canvas.width = imageDimensions.width;
    canvas.height = imageDimensions.height;

    const img = new Image();
    img.src = imageSrc;
    img.onload = () => {
      // Clear before draw
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.drawImage(img, 0, 0);

      // Draw Overlays
      sprites.forEach(sprite => {
        const isSelected = selectedSpriteId === sprite.id;

        // Box
        ctx.strokeStyle = isSelected ? '#3b82f6' : 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = isSelected ? 3 : 1;
        ctx.strokeRect(sprite.x, sprite.y, sprite.w, sprite.h);

        // Fill
        ctx.fillStyle = isSelected ? 'rgba(59, 130, 246, 0.2)' : 'rgba(239, 68, 68, 0.05)';
        ctx.fillRect(sprite.x, sprite.y, sprite.w, sprite.h);
      });

      if (currentRect) {
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2;
        ctx.strokeRect(currentRect.x, currentRect.y, currentRect.w, currentRect.h);
      }
    };

  }, [imageSrc, imageDimensions, sprites, currentRect, selectedSpriteId]);

  // Code Gen
  const generateCode = () => {
    if (sprites.length === 0) return '/* Paste images to generate Mixins */';

    if (codeMode === 'scss') {
      const width = imageDimensions.width;
      const height = imageDimensions.height;

      let code = `/* Generated by Sprite Builder */
/* Binary Source Size: ${width}x${height}px */

// 1. Config Map
$sprite-image: 'sprites.png';
$sprite-width: ${width}px;
$sprite-height: ${height}px;

$sprites: (\n`;

      sprites.forEach(s => {
        code += `  '${s.name}': (x: -${s.x}px, y: -${s.y}px, w: ${s.w}px, h: ${s.h}px),\n`;
      });

      code += `);\n\n// 2. Mixin: Reference by Tag Name\n@mixin sprite($name) {\n  $icon: map-get($sprites, $name);\n  background-image: url(#{$sprite-image});\n  background-repeat: no-repeat;\n  background-size: $sprite-width $sprite-height;\n  background-position: map-get($icon, 'x') map-get($icon, 'y');\n  width: map-get($icon, 'w');\n  height: map-get($icon, 'h');\n  \n  // UX: Disable default touch actions for better gesture control\n  touch-action: none;\n}\n\n`;

      code += `// 3. Highlight Helper (GPU Accelerated)\n// Perfect for click/touch feedback on transparent PNGs\n@mixin sprite-highlight($scale: 1.1) {\n  filter: drop-shadow(0 4px 6px rgba(0,0,0,0.2)) brightness(1.1);\n  transform: scale($scale);\n  transition: transform 0.1s ease, filter 0.1s ease;\n}\n\n// Usage:\n// .btn-play { @include sprite('start-btn'); }\n// .btn-play:active { @include sprite-highlight; }`;
      return code;
    }

    if (codeMode === 'css') {
      let code = `/* Base Class */\n.sprite {\n  background-image: url('sprites.png');\n  background-repeat: no-repeat;\n  display: inline-block;\n  background-size: ${imageDimensions.width}px ${imageDimensions.height}px;\n}\n\n`;
      sprites.forEach(s => {
        code += `/* Tag: ${s.name} */\n.${s.name} {\n  width: ${s.w}px;\n  height: ${s.h}px;\n  background-position: -${s.x}px -${s.y}px;\n}\n`;
      });
      return code;
    }

    if (codeMode === 'json') {
      const map = {};
      sprites.forEach(s => {
        map[s.name] = { x: s.x, y: s.y, width: s.w, height: s.h };
      });
      return JSON.stringify(map, null, 2);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generateCode());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  link.click();
};

const explodeSprites = async () => {
  if (!imageSrc || sprites.length === 0) return;

  const confirmExplode = confirm("This will decompose the sprite sheet into individual images. The layout might change when auto-packed. Continue?");
  if (!confirmExplode) return;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = imageSrc;
  // Ensure image is loaded
  if (!img.complete) {
    await new Promise(r => img.onload = r);
  }

  const promises = sprites.map(sprite => {
    return new Promise(resolve => {
      const canvas = document.createElement('canvas');
      canvas.width = sprite.w;
      canvas.height = sprite.h;
      const ctx = canvas.getContext('2d');
      // Draw only the slice
      ctx.drawImage(img, sprite.x, sprite.y, sprite.w, sprite.h, 0, 0, sprite.w, sprite.h);

      canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const itemImg = new Image();
        itemImg.onload = () => {
          resolve({
            id: Date.now() + Math.random(), // New ID to avoid conflicts
            name: sprite.name,
            tag: sprite.name, // Preserve tag
            w: sprite.w,
            h: sprite.h,
            imgElement: itemImg,
            originalSrc: url
          });
        };
        itemImg.src = url;
      }, 'image/png');
    });
  });

  const items = await Promise.all(promises);
  setBuildItems(items);
  setAppMode('build');
  // Repack to ensure consistency in build mode
  repackSprites(items);
};

const clearAll = async () => {
  if (confirm('Are you sure? This will delete the saved session.')) {
    setBuildItems([]);
    setSprites([]);
    setImageSrc(null);
    setAppMode('analyze');
    setImageDimensions({ width: 0, height: 0 });
    await db.clear(); // Wipe DB
    setLastSaved(null);
  }
};

return (
  <div className="flex flex-col h-screen bg-slate-50 text-slate-800 font-sans">
    {/* Header */}
    <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm z-10">
      <div className="flex items-center gap-2">
        <Wand2 className="w-6 h-6 text-indigo-600" />
        <h1 className="text-xl font-bold text-slate-800">Sprite Builder</h1>
        <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${mode === 'analyze' ? 'bg-slate-200 text-slate-600' : 'bg-indigo-100 text-indigo-700'}`}>
          {mode === 'analyze' ? 'Analyzer' : 'Builder'}
        </span>

        {/* Save Indicator */}
        <div className="ml-4 flex items-center gap-2 text-xs">
          {isSaving ? (
            <span className="text-slate-400 flex items-center gap-1 animate-pulse"><RefreshCw className="w-3 h-3" /> Saving...</span>
          ) : lastSaved ? (
            <span className="text-emerald-600 flex items-center gap-1"><Database className="w-3 h-3" /> Saved locally</span>
          ) : null}
        </div>
      </div>

      <div className="flex gap-3">
        {imageSrc && (
          <button onClick={clearAll} className="flex items-center gap-2 px-3 py-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors text-sm font-medium">
            <Trash2 className="w-4 h-4" /> Reset
          </button>
        )}
        {imageSrc && (
          <button onClick={downloadSpriteSheet} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors shadow-sm text-sm font-medium">
            <Download className="w-4 h-4" /> Save PNG
          </button>
        )}
        <label className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg cursor-pointer transition-colors shadow-sm text-sm font-medium">
          <Upload className="w-4 h-4" />
          <span>Upload</span>
          <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
        </label>
        <button onClick={handleShareUrl} className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors shadow-sm text-sm font-medium border border-slate-300">
          <Share2 className="w-4 h-4" />
          <span>Share</span>
        </button>
      </div>
    </header>


    {/* Main Content */}
    <div className="flex flex-1 overflow-hidden">

      {/* Left: Sidebar & Controls */}
      <div className="w-80 bg-white border-r border-slate-200 flex flex-col z-10 shadow-[4px_0_24px_rgba(0,0,0,0.02)]">
        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-slate-700">Tags ({sprites.length})</h3>
            {mode === 'analyze' && imageSrc && (
              <button
                onClick={() => setShowGridModal(true)}
                className="text-xs flex items-center gap-1 text-blue-600 hover:bg-blue-50 px-2 py-1 rounded"
              >
                <Grid className="w-3 h-3" /> Auto Grid
              </button>
            )}
            {mode === 'analyze' && sprites.length > 0 && (
              <button
                onClick={explodeSprites}
                className="text-xs flex items-center gap-1 text-orange-600 hover:bg-orange-50 px-2 py-1 rounded ml-2"
                title="Convert to individual items"
              >
                <Scissors className="w-3 h-3" /> Explode
              </button>
            )}
          </div>

          {mode === 'build' && sprites.length === 0 && (
            <div className="mb-4 p-4 bg-indigo-50 border border-indigo-100 rounded-lg text-xs text-indigo-800">
              <div className="font-bold mb-1 flex items-center gap-2"><Layers className="w-3 h-3" /> Builder Mode</div>
              Paste multiple images <strong>(Cmd+V)</strong>. They will auto-pack. Rename them below to create your Mixin keys.
            </div>
          )}

          <div className="space-y-2">
            {sprites.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-8 italic">
                {mode === 'analyze' ? "Draw boxes on the image or use Auto Grid." : "Paste images to start."}
              </div>
            ) : (
              sprites.map(sprite => (
                <div
                  key={sprite.id}
                  onClick={() => setSelectedSpriteId(sprite.id)}
                  className={`group p-2 rounded-lg border transition-all cursor-pointer ${selectedSpriteId === sprite.id ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-slate-200 hover:border-slate-300'}`}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-slate-200 rounded overflow-hidden flex-shrink-0 border border-slate-300">
                      {/* Mini Preview */}
                      <div
                        style={{
                          width: '100%', height: '100%',
                          backgroundImage: `url(${imageSrc})`,
                          backgroundPosition: `-${sprite.x}px -${sprite.y}px`,
                          backgroundSize: `${imageDimensions.width}px ${imageDimensions.height}px`
                        }}
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 bg-white border border-slate-200 rounded px-2 py-1 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500">
                        <Tag className="w-3 h-3 text-slate-400" />
                        <input
                          value={sprite.name}
                          onChange={(e) => handleTagChange(sprite.id, e.target.value)}
                          placeholder="tag-name"
                          className="flex-1 min-w-0 text-sm font-medium text-slate-700 focus:outline-none"
                        />
                      </div>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const newSprites = sprites.filter(s => s.id !== sprite.id);
                        setSprites(newSprites);
                        if (mode === 'build') {
                          const newItems = buildItems.filter(i => i.id !== sprite.id);
                          setBuildItems(newItems);
                          repackSprites(newItems);
                        }
                      }}
                      className="text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Center: Canvas Workspace */}
      <div className="flex-1 bg-slate-100 overflow-auto relative flex items-center justify-center p-8" ref={containerRef}>
        {imageSrc ? (
          <div
            className="relative shadow-2xl bg-white checkerboard"
            style={{
              width: imageDimensions.width * zoom,
              height: imageDimensions.height * zoom,
              cursor: mode === 'analyze' ? (isDrawing ? 'crosshair' : 'default') : 'default'
            }}
          >
            <canvas
              ref={canvasRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              className="block"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
            />
          </div>
        ) : (
          <div className="text-center p-12 max-w-md">
            <div className="w-20 h-20 bg-slate-200 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <Zap className="w-10 h-10 text-slate-400" />
            </div>
            <h2 className="text-2xl font-bold text-slate-700 mb-2">Sprite Builder</h2>
            <p className="text-slate-500 mb-8">
              Everything you paste or upload is <strong>Auto-Saved</strong> to your browser's local database.
            </p>
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-lg shadow-sm text-left">
                <div className="bg-indigo-100 p-2 rounded text-indigo-600 font-bold">1</div>
                <div className="text-sm text-slate-600">Copy image/subject from MacOS</div>
              </div>
              <div className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-lg shadow-sm text-left">
                <div className="bg-indigo-100 p-2 rounded text-indigo-600 font-bold">2</div>
                <div className="text-sm text-slate-600"><strong>Paste (Cmd+V)</strong> here to Auto-Pack</div>
              </div>
              <div className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-lg shadow-sm text-left">
                <div className="bg-indigo-100 p-2 rounded text-indigo-600 font-bold">3</div>
                <div className="text-sm text-slate-600">Rename Tags & Download Code</div>
              </div>
            </div>
          </div>
        )}

        {imageSrc && (
          <div className="absolute bottom-6 right-6 bg-white p-2 rounded-lg shadow-lg border border-slate-200 flex gap-2">
            <button onClick={() => setZoom(z => Math.max(0.2, z - 0.2))} className="p-2 hover:bg-slate-100 rounded">-</button>
            <span className="px-2 py-2 text-sm font-medium w-16 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(3, z + 0.2))} className="p-2 hover:bg-slate-100 rounded">+</button>
          </div>
        )}
      </div>

      {/* Right: Code Output */}
      <div className="w-96 bg-white border-l border-slate-200 flex flex-col shadow-[-4px_0_24px_rgba(0,0,0,0.02)] z-10">
        <div className="p-4 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2 mb-4">
            <Code className="w-4 h-4 text-slate-500" />
            <h3 className="font-semibold text-slate-700">Mixin Output</h3>
          </div>
          <div className="flex bg-white rounded-lg p-1 border border-slate-200 shadow-sm">
            {['scss', 'css', 'json'].map(m => (
              <button
                key={m}
                onClick={() => setCodeMode(m)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${codeMode === m ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:text-slate-700'}`}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 relative bg-slate-900 overflow-hidden group">
          <textarea
            className="w-full h-full bg-transparent text-blue-300 p-4 font-mono text-xs resize-none focus:outline-none"
            readOnly
            value={generateCode()}
          />
          <button
            onClick={copyToClipboard}
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 text-white rounded-lg backdrop-blur-sm transition-all opacity-0 group-hover:opacity-100"
          >
            {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>

        <div className="p-4 bg-slate-50 border-t border-slate-200 text-xs text-slate-500">
          <p>Interactive Preview:</p>
          <div className="mt-2 w-full h-24 bg-white border border-slate-200 rounded-lg flex items-center justify-center overflow-hidden relative checkerboard">
            {selectedSpriteId ? (
              sprites.filter(s => s.id === selectedSpriteId).map(s => (
                <div
                  key={s.id}
                  className="transition-all duration-200 hover:scale-110 filter hover:drop-shadow-lg cursor-pointer"
                  title="Hover me to test highlight!"
                  style={{
                    width: s.w,
                    height: s.h,
                    backgroundImage: `url(${imageSrc})`,
                    backgroundPosition: `-${s.x}px -${s.y}px`,
                    backgroundSize: `${imageDimensions.width}px ${imageDimensions.height}px`
                  }}
                />
              ))
            ) : (
              <span className="text-slate-400 italic">Select a sprite to test UX</span>
            )}
          </div>
        </div>
      </div>

    </div>

    {/* Grid Modal */}
    {showGridModal && (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm">
        <div className="bg-white rounded-xl shadow-2xl p-6 w-80 transform transition-all scale-100">
          <h3 className="text-lg font-bold text-slate-800 mb-4">Auto-Generate Grid</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Rows</label>
              <input
                type="number"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 outline-none"
                value={gridConfig.rows}
                onChange={(e) => setGridConfig({ ...gridConfig, rows: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Columns</label>
              <input
                type="number"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 outline-none"
                value={gridConfig.cols}
                onChange={(e) => setGridConfig({ ...gridConfig, cols: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Padding (px)</label>
              <input
                type="number"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 outline-none"
                value={gridConfig.padding}
                onChange={(e) => setGridConfig({ ...gridConfig, padding: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="flex gap-2 mt-6">
            <button onClick={() => setShowGridModal(false)} className="flex-1 px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg font-medium">Cancel</button>
            <button onClick={generateGrid} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium shadow-sm">Generate</button>
          </div>
        </div>
      </div>
    )}

    <style>{`
        .checkerboard {
            background-color: #f0f0f0;
            background-image: linear-gradient(45deg, #e5e5e5 25%, transparent 25%), linear-gradient(-45deg, #e5e5e5 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e5e5 75%), linear-gradient(-45deg, transparent 75%, #e5e5e5 75%);
            background-size: 20px 20px;
            background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
        }
      `}</style>
  </div>
);
};

export default App;
