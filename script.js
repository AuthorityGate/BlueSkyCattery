// ========================================
// Blue Sky Cattery - Main JavaScript
// ========================================

// --- Mobile Navigation ---
document.addEventListener('DOMContentLoaded', function () {
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');

    if (navToggle && navMenu) {
        navToggle.addEventListener('click', function () {
            navMenu.classList.toggle('nav-open');
            navToggle.classList.toggle('nav-active');
        });

        // Close menu on link click
        navMenu.querySelectorAll('a').forEach(function (link) {
            link.addEventListener('click', function () {
                navMenu.classList.remove('nav-open');
                navToggle.classList.remove('nav-active');
            });
        });
    }

    // --- Navbar scroll behavior (home page only) ---
    const navbar = document.getElementById('navbar');
    if (navbar && !navbar.classList.contains('navbar-solid')) {
        window.addEventListener('scroll', function () {
            if (window.scrollY > 80) {
                navbar.classList.add('navbar-scrolled');
            } else {
                navbar.classList.remove('navbar-scrolled');
            }
        });
    }

    // --- Scroll animations ---
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-in');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    document.querySelectorAll('.feature-card, .breed-preview-card, .royal-card, .kitten-card, .step, .philosophy-card, .faq-item, .included-card, .gallery-item').forEach(function (el) {
        el.classList.add('animate-target');
        observer.observe(el);
    });

    // --- Smooth scroll for anchor links ---
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
        anchor.addEventListener('click', function (e) {
            var targetId = this.getAttribute('href');
            if (targetId === '#') return;
            var target = document.querySelector(targetId);
            if (target) {
                e.preventDefault();
                var offset = 80;
                var pos = target.getBoundingClientRect().top + window.pageYOffset - offset;
                window.scrollTo({ top: pos, behavior: 'smooth' });
            }
        });
    });

});


// --- Reservation Modal ---
var selectedKitten = null;

function openReservation(kittenNum) {
    selectedKitten = kittenNum;
    var modal = document.getElementById('reservationModal');
    var kittenName = document.getElementById('modalKittenName');
    var form = document.getElementById('reservationForm');
    var success = document.getElementById('formSuccess');

    kittenName.textContent = 'Kitten #' + kittenNum;
    // Set hidden fields for the native form submission
    var kittenField = document.getElementById('resKitten');
    var subjectField = document.getElementById('resSubject');
    if (kittenField) kittenField.value = 'Kitten #' + kittenNum;
    if (subjectField) subjectField.value = 'Kitten Reservation Request - Kitten #' + kittenNum;

    form.style.display = 'block';
    success.style.display = 'none';
    modal.classList.add('modal-active');
    document.body.style.overflow = 'hidden';
}

function closeReservation() {
    var modal = document.getElementById('reservationModal');
    modal.classList.remove('modal-active');
    document.body.style.overflow = '';
}

// (Old FormSubmit handler removed - using submitReserveForm via portal API now)

// Close modal on overlay click
document.addEventListener('click', function (e) {
    if (e.target.classList.contains('modal-overlay') && e.target.classList.contains('modal-active')) {
        closeReservation();
    }
});

// Close modal on Escape
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        closeReservation();
    }
});


// --- Portal API ---
var PORTAL_API = 'https://portal.blueskycattery.com/api';

// Contact Form - sends to portal API, redirects to thanks page
function submitContactForm(e) {
    e.preventDefault();
    var form = document.getElementById('contactForm');
    var submitBtn = form.querySelector('button[type="submit"]');
    var fd = new FormData(form);
    var data = {};
    fd.forEach(function (v, k) { data[k] = v; });

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    fetch(PORTAL_API + '/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(function (res) { return res.json(); })
    .then(function (result) {
        if (result.success) {
            window.location.href = 'thanks.html';
        } else {
            alert('Something went wrong. Please try again or email Deanna@blueskycattery.com directly.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Send Message';
        }
    }).catch(function () {
        alert('Connection error. Please try again or email Deanna@blueskycattery.com directly.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Message';
    });
    return false;
}

// Reservation Form - sends to portal API, redirects to thanks page
function submitReserveForm(e) {
    e.preventDefault();
    var form = document.getElementById('reservationForm');
    var submitBtn = form.querySelector('button[type="submit"]');
    var fd = new FormData(form);
    var data = {};
    fd.forEach(function (v, k) { data[k] = v; });

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    fetch(PORTAL_API + '/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(function (res) { return res.json(); })
    .then(function (result) {
        if (result.success) {
            window.location.href = 'thanks.html';
        } else {
            alert('Something went wrong. Please try again or email Deanna@blueskycattery.com directly.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Reservation Request';
        }
    }).catch(function () {
        alert('Connection error. Please try again or email Deanna@blueskycattery.com directly.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Reservation Request';
    });
    return false;
}
