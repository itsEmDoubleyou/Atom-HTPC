const track = document.getElementById('switcher-track');

const CARD_SPACING_RATIO = { large: 0.48, small: 0.34 }; // Anteil der Fensterbreite zwischen den Kartenmitten
const CLOSE_DRAG_THRESHOLD = 100; // px nach oben gezogen, bis die Karte schließt

let apps = [];
let selectedIndex = 0;
let cardEls = []; // Wrapper-Elemente (Label + Karte), Transform wirkt auf diese
let dragState = null; // { wrapper, index, startY }
let tabsSettings = { keepPlayingInBackground: false, cardSize: 'large', showLabel: true };

async function init() {
  tabsSettings = await window.electronAPI.getTabsSettings();
  track.classList.toggle('size-small', tabsSettings.cardSize === 'small');

  apps = await window.electronAPI.getRunningApps();

  if (apps.length === 0) {
    // Nichts im Hintergrund - Umschalter macht ohne Inhalt keinen Sinn
    window.electronAPI.switcherCancel();
    return;
  }

  selectedIndex = 0;
  renderCards();
}

function spacing() {
  const ratio = CARD_SPACING_RATIO[tabsSettings.cardSize] || CARD_SPACING_RATIO.large;
  return window.innerWidth * ratio;
}

function renderCards() {
  track.innerHTML = '';

  cardEls = apps.map((appData, index) => {
    // Wrapper hält Label (oben, tvOS-Stil) + Karte (darunter) zusammen -
    // die Pfeiltasten-/Zieh-Animation bewegt beides gemeinsam.
    const wrapper = document.createElement('div');
    wrapper.className = 'switcher-item';
    wrapper.dataset.id = appData.id;

    const label = document.createElement('div');
    label.className = 'switcher-item-label';

    if (appData.icon) {
      const icon = document.createElement('img');
      icon.className = 'switcher-item-icon';
      icon.src = appData.icon;
      icon.alt = '';
      label.appendChild(icon);
    }

    if (tabsSettings.showLabel) {
      const name = document.createElement('span');
      name.className = 'switcher-item-name';
      name.textContent = appData.name;
      label.appendChild(name);
    }

    wrapper.appendChild(label);

    const card = document.createElement('div');
    card.className = 'switcher-card';

    if (appData.thumbnail) {
      const img = document.createElement('img');
      img.className = 'switcher-card-thumb';
      img.src = appData.thumbnail;
      img.alt = '';
      card.appendChild(img);
    } else {
      card.classList.add('no-thumb');
    }

    wrapper.appendChild(card);

    wrapper.addEventListener('click', () => {
      const currentIndex = cardEls.indexOf(wrapper);
      if (currentIndex === selectedIndex) {
        openSelected();
      } else {
        selectedIndex = currentIndex;
        layoutCards();
      }
    });

    wrapper.addEventListener('mousedown', (e) => {
      const currentIndex = cardEls.indexOf(wrapper);
      dragState = { wrapper, index: currentIndex, startY: e.clientY };
      wrapper.classList.add('dragging');
    });

    track.appendChild(wrapper);
    return wrapper;
  });

  layoutCards();
}

function layoutCards() {
  const gap = spacing();
  cardEls.forEach((wrapper, index) => {
    const offset = index - selectedIndex;
    const isActive = offset === 0;
    wrapper.style.transform = `translateX(${offset * gap}px) scale(${isActive ? 1 : 0.75})`;
    wrapper.style.opacity = Math.abs(offset) > 3 ? '0' : (isActive ? '1' : '0.55');
    wrapper.style.zIndex = String(10 - Math.abs(offset));
    wrapper.classList.toggle('active', isActive);
  });
}

function moveSelection(delta) {
  selectedIndex = Math.max(0, Math.min(selectedIndex + delta, apps.length - 1));
  layoutCards();
}

let opening = false;

function openSelected() {
  const appData = apps[selectedIndex];
  if (!appData || opening) return;
  opening = true;
  document.body.classList.add('fade-out');
  setTimeout(() => {
    window.electronAPI.switcherSelectApp(appData.id);
  }, 300);
}

function closeSelected() {
  closeCardAtIndex(selectedIndex);
}

function closeCardAtIndex(index) {
  const wrapper = cardEls[index];
  const appData = apps[index];
  if (!wrapper || !appData) return;

  const gap = spacing();
  const offset = index - selectedIndex;
  const isActive = offset === 0;
  wrapper.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
  wrapper.style.transform = `translateX(${offset * gap}px) scale(${isActive ? 1 : 0.75}) translateY(-140%)`;
  wrapper.style.opacity = '0';

  window.electronAPI.switcherCloseApp(appData.id);

  setTimeout(() => {
    apps.splice(index, 1);
    cardEls.splice(index, 1);
    wrapper.remove(); // nur diese eine Karte raus, Rest bleibt bestehen

    if (apps.length === 0) {
      window.electronAPI.switcherCancel();
      return;
    }

    selectedIndex = Math.min(selectedIndex, apps.length - 1);
    layoutCards(); // bestehende Karten haben eine "alte" Position -> animiert smooth zur neuen
  }, 200);
}

// ---------- Tastatur ----------
window.addEventListener('keydown', (e) => {
  if (e.code === 'ArrowLeft') {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    moveSelection(1);
  } else if (e.code === 'ArrowUp') {
    e.preventDefault();
    closeSelected();
  } else if (e.code === 'Enter') {
    e.preventDefault();
    openSelected();
  }
});

// ---------- Mausrad: hoch/runter wechselt ebenfalls zwischen den Apps ----------
window.addEventListener('wheel', (e) => {
  if (e.deltaY > 0) moveSelection(1);
  else if (e.deltaY < 0) moveSelection(-1);
});

// ---------- Klicken, halten, nach oben ziehen schließt die Karte ----------
window.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const deltaY = e.clientY - dragState.startY;
  if (deltaY >= 0) return; // nur nach oben ziehen hat einen Effekt

  const offset = dragState.index - selectedIndex;
  const isActive = offset === 0;
  dragState.wrapper.style.transition = 'none';
  dragState.wrapper.style.transform =
    `translateX(${offset * spacing()}px) scale(${isActive ? 1 : 0.75}) translateY(${deltaY}px)`;
});

window.addEventListener('mouseup', (e) => {
  if (!dragState) return;
  const { wrapper, index, startY } = dragState;
  wrapper.classList.remove('dragging');
  wrapper.style.transition = '';
  const deltaY = e.clientY - startY;
  dragState = null;

  if (deltaY <= -CLOSE_DRAG_THRESHOLD) {
    closeCardAtIndex(index);
  } else {
    layoutCards(); // zurückschnappen in die normale Position
  }
});

window.addEventListener('DOMContentLoaded', init);
