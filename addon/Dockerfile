ARG BUILD_FROM
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8

# ── סביבת ריצה: Node.js ──
RUN apk add --no-cache nodejs npm

WORKDIR /app

# ── התקנת תלויות (שכבה נפרדת ל-cache יעיל) ──
# npm ci מתקין בדיוק את הגרסאות שב-package-lock.json — בנייה זהה בכל פעם, בלי הפתעות
# מגרסה חדשה של תלות שיצאה בין בנייה לבנייה. כל התלויות הן JS טהור (bcryptjs ולא
# bcrypt הנייטיב), ולכן אין צורך ב-python3/make/g++ בתמונה, והבנייה עובדת גם על ARM.
COPY rootfs/app/package.json rootfs/app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── קוד האפליקציה ──
COPY rootfs/app/ ./

# ── סקריפט הפעלה ──
COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
