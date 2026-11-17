// socket.io: მონაცემების ცვლილებისას ყველა დაკავშირებულ კლიენტს ეგზავნება "changed"; კლიენტი თავად ხელახლა კითხულობს თავის (უფლებებით გაფილტრულ) მონაცემებს
let io = null;
module.exports = { setIO: x => { io = x; }, emit: (what = 'docs') => { try { io && io.emit('changed', { what }); } catch {} } };
