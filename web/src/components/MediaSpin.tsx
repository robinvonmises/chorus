/** Ladekreis über noch nicht geladenen Medien: reines CSS, verschwindet, sobald das Geschwister-Element davor die Klasse „ok“ hat.
 *  Erscheint erst nach kurzer Verzögerung, damit er bei Bildern aus dem Cache nicht aufblitzt. */
export const MediaSpin = ({ big }: { big?: boolean }) => <i className={big ? 'media-spin big' : 'media-spin'} aria-hidden />;
/** Ohne React-State (kein Neu-Rendern): Klasse direkt am Element setzen */
export const loaded = (e: { currentTarget: Element }) => e.currentTarget.classList.add('ok');
