(function (root) {
  'use strict';

  function createCell(stringNo, fret, note) {
    const cell = document.createElement('span');
    cell.className = 'fret-cell';
    if (note && Number(note.fret) === fret) {
      cell.classList.add('active');
      cell.textContent = String(fret)
        + (note.lh ? ' · ' + note.lh : '')
        + (note.rh ? ' · ' + note.rh : '');
      cell.title = '현 ' + stringNo + ' · ' + fret + '프렛 · MIDI ' + note.midi;
    } else {
      cell.textContent = fret === 0 ? '○' : String(fret);
    }
    return cell;
  }

  function createStringRow(stringNo, note, frets) {
    const row = document.createElement('div');
    row.className = 'fret-string';
    row.style.gridTemplateColumns = '26px repeat('
      + frets.length + ', minmax(0, 1fr))';

    const label = document.createElement('span');
    label.className = 'string-name';
    label.textContent = String(stringNo);
    row.appendChild(label);

    frets.forEach(fret => {
      row.appendChild(createCell(stringNo, fret, note));
    });
    return row;
  }

  function render(container, beat) {
    if (!container) return;
    const notes = root.TabEngine.getBeatNotes(beat);
    const tuning = beat?.voice?.bar?.staff?.tuning || [];
    const stringCount = tuning.length || 6;

    if (!notes.length) {
      container.innerHTML = '<div class="notice">현재 탄현 위치가 없어.</div>';
      return;
    }

    const notesByString = new Map(notes.map(note => [note.str, note]));
    const fretSet = new Set([0, 1, 2, 3, 4, 5]);
    notes.forEach(note => fretSet.add(Number(note.fret)));
    const frets = Array.from(fretSet).sort((a, b) => a - b);
    container.replaceChildren();
    for (let stringNo = 1; stringNo <= stringCount; stringNo++) {
      container.appendChild(createStringRow(
        stringNo,
        notesByString.get(stringNo),
        frets
      ));
    }
  }

  root.GuitarFretboard = { render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
